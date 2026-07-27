#!/usr/bin/env python3
import asyncio
from contextlib import asynccontextmanager
import hashlib
import io
import os
import re
import tempfile
from collections import defaultdict
from pathlib import Path

import numpy as np
from aiohttp import web
from PIL import Image

EXPOSED_FILES = {"qcamera.ts", "fcamera.hevc", "dcamera.hevc", "ecamera.hevc"}
ROUTE_RE, SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$"), re.compile(r"^\d+$")
SEGMENT_NAME_RE = re.compile(r"^(.+)--(\d+)$")

def route_and_segment(name):
  """loggerd uses <route>--<final numeric segment>; split only at that suffix."""
  match = SEGMENT_NAME_RE.fullmatch(name)
  return match.groups() if match else None

def contained(root, path):
  try:
    root, path = Path(root).resolve(strict=True), Path(path).resolve(strict=True)
    path.relative_to(root)
    return path
  except (OSError, ValueError):
    return None

def preview_cache_key(path, stat=None):
  stat = stat or Path(path).stat()
  value = f"{Path(path).resolve()}:{stat.st_size}:{stat.st_mtime_ns}"
  return hashlib.sha256(value.encode()).hexdigest()

def remux_preview(source, destination):
  """Copy browser-compatible qcamera streams; never decode or transcode them."""
  import av
  source, destination = Path(source), Path(destination)
  input_container = output_container = None
  try:
    input_container = av.open(str(source))
    streams = [s for s in input_container.streams if s.type in ("video", "audio")]
    if not any(s.type == "video" for s in streams) or any(s.codec_context.name not in ({"h264"} if s.type == "video" else {"aac"}) for s in streams):
      raise ValueError("preview requires H.264/AAC")
    output_container = av.open(str(destination), "w", format="mp4", options={"movflags": "+faststart+frag_keyframe+empty_moov+default_base_moof"})
    output_streams = {}
    for stream in streams:
      output_streams[stream.index] = output_container.add_stream_from_template(stream)
    for packet in input_container.demux(streams):
      if packet.dts is not None:
        packet.stream = output_streams[packet.stream.index]
        output_container.mux(packet)
  finally:
    if output_container is not None: output_container.close()
    if input_container is not None: input_container.close()

async def connect_live_client(factory, timeout, retry=.1):
  """Retry blocking VisionIPC setup off the aiohttp event loop."""
  loop, deadline = asyncio.get_running_loop(), asyncio.get_running_loop().time() + timeout
  while True:
    client = None
    try:
      client = await asyncio.to_thread(factory)
      if await asyncio.to_thread(client.connect, False): return client
    except Exception:
      pass
    if client is not None:
      close = getattr(client, "close", None)
      if callable(close):
        try: close()
        except Exception: pass
    if loop.time() >= deadline: raise RuntimeError("camera unavailable")
    await asyncio.sleep(min(retry, max(0, deadline - loop.time())))

@asynccontextmanager
async def leased_live_client(lease, factory, timeout):
  lease.acquire()
  client = None
  try:
    client = await connect_live_client(factory, timeout)
    yield client
  finally:
    if client is not None:
      close = getattr(client, "close", None)
      if callable(close):
        try: close()
        except Exception: pass
    lease.release()

def vision_client_factory(camera):
  from msgq.visionipc import VisionIpcClient, VisionStreamType
  stream = {"road": VisionStreamType.VISION_STREAM_ROAD, "driver": VisionStreamType.VISION_STREAM_DRIVER}.get(camera)
  if stream is None: raise KeyError(camera)
  return lambda: VisionIpcClient("camerad", stream, conflate=True)

class RouteStore:
  def __init__(self, roots=None):
    if roots is None:
      from openpilot.system.hardware.hw import Paths
      roots = (Paths.log_root(), Paths.log_root_external())
    self.roots = [Path(p) for p in roots]

  def _segments(self):
    result = defaultdict(list)
    for root in self.roots:
      root = contained(root, root)
      if root is None: continue
      try: entries = list(root.iterdir())
      except OSError: continue
      for entry in entries:
        parsed, path = route_and_segment(entry.name), contained(root, entry)
        if parsed and path and path.is_dir() and ROUTE_RE.fullmatch(parsed[0]):
          result[parsed[0]].append((int(parsed[1]), parsed[1], path, root))
    return result

  @staticmethod
  def _info(number, path):
    files, newest, active = [], 0., False
    try: entries = list(path.iterdir())
    except OSError: entries = []
    for entry in entries:
      try:
        if entry.is_file() and entry.name in EXPOSED_FILES and contained(path, entry):
          stat = entry.stat(); files.append({"name": entry.name, "size": stat.st_size}); newest = max(newest, stat.st_mtime)
        active |= entry.name.endswith(".lock") or entry.name == "lock"
      except OSError: pass
    return {"id": number, "files": files, "cameras": [f["name"] for f in files], "size": sum(f["size"] for f in files), "mtime": newest, "active": active}

  def routes(self):
    out = []
    for route, segments in self._segments().items():
      info = [self._info(n, p) for _, n, p, _ in sorted(segments)]
      out.append({"id": route, "segments": len(info), "mtime": max((x["mtime"] for x in info), default=0), "size": sum(x["size"] for x in info), "active": any(x["active"] for x in info)})
    return sorted(out, key=lambda x: x["mtime"], reverse=True)

  def route(self, route):
    segments = self._segments().get(route) if ROUTE_RE.fullmatch(route) else None
    if not segments: return None
    info = [self._info(n, p) for _, n, p, _ in sorted(segments)]
    return {"id": route, "segments": info, "segment_count": len(info), "mtime": max(x["mtime"] for x in info), "size": sum(x["size"] for x in info), "active": any(x["active"] for x in info)}

  def file(self, route, segment, filename):
    if not ROUTE_RE.fullmatch(route) or not SEGMENT_RE.fullmatch(segment) or filename not in EXPOSED_FILES: return None
    for _, n, directory, root in self._segments().get(route, []):
      if n == segment: return contained(root, directory / filename)
    return None

class DriverViewLease:
  def __init__(self, params, grace=2.): self.params, self.grace, self.clients, self.owned, self.timer = params, grace, 0, False, None
  def acquire(self):
    self.clients += 1
    if self.timer: self.timer.cancel(); self.timer = None
    if self.clients == 1 and self.params.get_bool("IsOffroad") and not self.params.get_bool("IsDriverViewEnabled"):
      self.params.put_bool("IsDriverViewEnabled", True); self.owned = True
  def release(self):
    self.clients = max(0, self.clients - 1)
    if not self.clients: self.timer = asyncio.get_running_loop().call_later(self.grace, self.clear)
  def clear(self):
    self.timer = None
    if not self.clients and self.owned: self.params.put_bool("IsDriverViewEnabled", False); self.owned = False
  def close(self):
    if self.timer: self.timer.cancel()
    self.clients = 0; self.clear()

def jpeg_from_frame(frame):
  y = np.asarray(frame.data[:frame.uv_offset], dtype=np.uint8).reshape((-1, frame.stride))[:frame.height, :frame.width]
  uv = np.asarray(frame.data[frame.uv_offset:], dtype=np.uint8).reshape((-1, frame.stride))[:frame.height // 2, :frame.width]
  u, v = uv[:, 0::2], uv[:, 1::2]
  u, v = np.repeat(np.repeat(u, 2, axis=0), 2, axis=1), np.repeat(np.repeat(v, 2, axis=0), 2, axis=1)
  yuv = np.dstack((y, u[:frame.height, :frame.width], v[:frame.height, :frame.width])).astype(np.int16)
  yuv[:, :, 1:] -= 128
  rgb = np.dot(yuv, np.array([[1., 1., 1.], [0., -.39465, 2.03211], [1.13983, -.58060, 0.]])).clip(0, 255).astype(np.uint8)
  image = Image.fromarray(rgb); image.thumbnail((640, 480))
  out = io.BytesIO(); image.save(out, "JPEG", quality=75); return out.getvalue()

async def live(request):
  camera = request.match_info["camera"]
  if camera not in ("road", "driver"): raise web.HTTPNotFound()
  lease, response = request.app["lease"], None
  try:
    # Acquiring first starts camerad while offroad. Setup is retried without blocking routes.
    async with leased_live_client(lease, lambda: vision_client_factory(camera)(), float(os.getenv("C3_WEB_CAMERA_STARTUP", "5"))) as client:
      response = web.StreamResponse(headers={"Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-cache"}); await response.prepare(request)
      while True:
        frame = await asyncio.get_running_loop().run_in_executor(None, lambda: client.recv(timeout_ms=1000))
        if frame:
          data = jpeg_from_frame(frame); await response.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n")
        await asyncio.sleep(1 / max(1, int(os.getenv("C3_WEB_FPS", "5"))))
  except asyncio.CancelledError: raise
  except (ConnectionError, OSError): pass
  except Exception as exc: raise web.HTTPServiceUnavailable(text="camera unavailable") from exc
  assert response is not None
  return response

async def route_response(request):
  result = request.app["store"].route(request.match_info["route"])
  if result is None: raise web.HTTPNotFound()
  return web.json_response(result)

async def health_response(request):
  return web.json_response({"ok": True})

async def status_response(request):
  return web.json_response({"ok": True, "routes": len(request.app["store"].routes())})

async def routes_response(request):
  return web.json_response(request.app["store"].routes())

async def file_response(request):
  path = request.app["store"].file(**request.match_info)
  if path is None: raise web.HTTPNotFound()
  response = web.FileResponse(path)
  if path.suffix == ".hevc": response.headers["Content-Disposition"] = f'{"inline" if request.query.get("inline") == "1" else "attachment"}; filename="{path.name}"'
  return response

async def preview_response(request):
  path = request.app["store"].file(request.match_info["route"], request.match_info["segment"], "qcamera.ts")
  if path is None: raise web.HTTPNotFound()
  try:
    key = preview_cache_key(path)
  except OSError as exc:
    raise web.HTTPNotFound() from exc
  output = request.app["preview_dir"] / f"{key}.mp4"
  if not output.is_file():
    temporary = output.with_suffix(".tmp")
    async with request.app["preview_semaphore"]:
      if not output.is_file():
        try:
          temporary.unlink(missing_ok=True)
          await asyncio.to_thread(remux_preview, path, temporary)
          temporary.replace(output)
        except FileNotFoundError as exc:
          temporary.unlink(missing_ok=True)
          raise web.HTTPNotFound() from exc
        except Exception as exc:
          temporary.unlink(missing_ok=True)
          raise web.HTTPServiceUnavailable(text="preview unavailable") from exc
  return web.FileResponse(output, headers={"Content-Type": "video/mp4"})

def create_app(roots=None, params=None, preview_dir=None):
  if params is None:
    from openpilot.common.params import Params
    params = Params()
  preview_dir = Path(preview_dir or Path(tempfile.gettempdir()) / "c3-web-preview"); preview_dir.mkdir(parents=True, exist_ok=True)
  app = web.Application(); app["store"] = RouteStore(roots); app["lease"] = DriverViewLease(params, float(os.getenv("C3_WEB_DRIVER_GRACE", "2"))); app["preview_dir"] = preview_dir; app["preview_semaphore"] = asyncio.Semaphore(max(1, int(os.getenv("C3_WEB_PREVIEW_JOBS", "2"))))
  app.router.add_get("/health", health_response)
  app.router.add_get("/api/status", status_response)
  app.router.add_get("/api/routes", routes_response); app.router.add_get("/api/routes/{route}", route_response)
  app.router.add_get("/api/file/{route}/{segment}/{filename}", file_response); app.router.add_get("/api/preview/{route}/{segment}", preview_response); app.router.add_get("/api/live/{camera}", live)
  static = Path(__file__).parent / "static"
  if static.is_dir():
    async def index_response(request): return web.FileResponse(static / "index.html")
    app.router.add_get("/", index_response); app.router.add_static("/", static, show_index=False)
  async def cleanup(app): app["lease"].close()
  app.on_cleanup.append(cleanup); return app

def main():
  web.run_app(create_app(), host="0.0.0.0", port=int(os.getenv("C3_WEB_PORT", "8082")))

if __name__ == "__main__": main()

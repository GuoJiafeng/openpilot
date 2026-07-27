import asyncio

from openpilot.selfdrive.c3_web.c3_webd import DriverViewLease, RouteStore, connect_live_client, leased_live_client, main, preview_cache_key, route_and_segment


class FakeParams:
  def __init__(self, offroad=True, driver=False): self.values = {"IsOffroad": offroad, "IsDriverViewEnabled": driver}
  def get_bool(self, key): return self.values.get(key, False)
  def put_bool(self, key, value): self.values[key] = value


def test_route_listing_and_final_segment_split(tmp_path):
  assert route_and_segment("abc--def--12") == ("abc--def", "12")
  segment = tmp_path / "abc--def--12"; segment.mkdir()
  (segment / "qcamera.ts").write_bytes(b"x")
  (segment / "rlog.zst").write_bytes(b"secret")
  (segment / "upload.lock").touch()
  route = RouteStore([tmp_path]).route("abc--def")
  assert route["active"] and route["segments"][0]["files"] == [{"name": "qcamera.ts", "size": 1}]


def test_file_whitelist_and_symlink_escape(tmp_path):
  segment = tmp_path / "route--0"; segment.mkdir(); outside = tmp_path.parent / "outside.ts"; outside.write_bytes(b"x")
  (segment / "qcamera.ts").symlink_to(outside)
  store = RouteStore([tmp_path])
  assert store.file("route", "0", "qcamera.ts") is None
  assert store.file("../route", "0", "qcamera.ts") is None
  assert store.file("route", "0", "rlog.zst") is None


def test_preview_cache_key_is_stable_and_path_bound(tmp_path):
  first, second = tmp_path / "first.ts", tmp_path / "second.ts"
  first.write_bytes(b"x"); second.write_bytes(b"x")
  assert preview_cache_key(first) == preview_cache_key(first)
  assert preview_cache_key(first) != preview_cache_key(second)


def test_main_is_process_entrypoint():
  assert callable(main)


def test_live_connect_retries_without_blocking_loop():
  class Client:
    def __init__(self, succeeds): self.succeeds = succeeds
    def connect(self, _): return self.succeeds
  async def run():
    attempts = iter((Client(False), Client(True)))
    assert (await connect_live_client(lambda: next(attempts), .1, 0)).succeeds
  asyncio.run(run())


def test_live_lease_is_acquired_before_connect_and_released():
  async def run():
    params = FakeParams(); lease = DriverViewLease(params, 0)
    class Client:
      def connect(self, _): return True
    def factory():
      assert params.get_bool("IsDriverViewEnabled")
      return Client()
    async with leased_live_client(lease, factory, .1): pass
    await asyncio.sleep(.01)
    assert not params.get_bool("IsDriverViewEnabled") and lease.clients == 0
  asyncio.run(run())


def test_multiple_live_leases_keep_driver_view_enabled():
  async def run():
    params = FakeParams(); lease = DriverViewLease(params, 0)
    lease.acquire(); lease.acquire(); lease.release(); await asyncio.sleep(.01)
    assert params.get_bool("IsDriverViewEnabled")
    lease.release(); await asyncio.sleep(.01)
    assert not params.get_bool("IsDriverViewEnabled")
  asyncio.run(run())


def test_driver_view_lease_preserves_existing_owner():
  params = FakeParams(driver=True); lease = DriverViewLease(params, 0)
  lease.acquire(); lease.clear()
  assert params.get_bool("IsDriverViewEnabled")


def test_driver_view_lease_clears_its_own_value():
  async def run():
    params = FakeParams(); lease = DriverViewLease(params, 0)
    lease.acquire(); assert params.get_bool("IsDriverViewEnabled")
    lease.release(); await asyncio.sleep(.01)
    assert not params.get_bool("IsDriverViewEnabled")
  asyncio.run(run())

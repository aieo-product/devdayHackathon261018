"""On-robot Reachy Mini application entry point."""

import threading

from reachy_mini import ReachyMini, ReachyMiniApp

from .api import FocusApi
from .hardware import ReachyHardware
from .runtime import Runtime
from .web import attach_routes


class ReachyFocus(ReachyMiniApp):
    custom_app_url = "http://0.0.0.0:8042"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.runtime = None
        if self.settings_app is not None:
            attach_routes(self.settings_app, lambda: self.runtime)

    def run(self, reachy_mini: ReachyMini, stop_event: threading.Event):
        hardware = ReachyHardware(reachy_mini)
        hardware.prepare_camera()
        if stop_event.is_set():
            return
        self.runtime = Runtime(hardware, FocusApi())
        self.runtime.run(stop_event)


if __name__ == "__main__":
    app = ReachyFocus()
    try:
        app.wrapped_run()
    except KeyboardInterrupt:
        app.stop()

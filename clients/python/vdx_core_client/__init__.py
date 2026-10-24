"""Send objects, events and files to VDX Core with a source token."""
from .client import Client, CoreError, event, obj, ref

__all__ = ["Client", "CoreError", "event", "obj", "ref"]

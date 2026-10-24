"""A small client for VDX Core's push endpoints (standard library only)."""
from __future__ import annotations

import json
import mimetypes
import os
import time
import uuid
import urllib.error
import urllib.request
from typing import Any, Iterable, Iterator, Optional, Union
from urllib.parse import quote, urlencode

Ref = Union[str, dict]


def ref(type: str, external_id: str) -> dict:
    """An object by its type and external id, instead of its Core id."""
    return {"type": type, "externalId": external_id}


def obj(type: str, external_id: str, *, name: Optional[str] = None, properties: Optional[dict] = None,
        defaults: Optional[dict] = None, links: Optional[dict] = None) -> dict:
    """An object to create or update. `defaults` only count when the object is new; a property
    set to None is removed."""
    m: dict[str, Any] = {"kind": "object", "type": type, "externalId": external_id, "properties": properties or {}}
    if name is not None:
        m["name"] = name
    if defaults:
        m["defaults"] = defaults
    if links:
        m["links"] = links
    return m


def event(type: str, *, key: str, payload: dict, objects: Iterable[Ref], ts: Optional[str] = None) -> dict:
    """An event, stored once per `key`: send the same key for the same run."""
    m: dict[str, Any] = {"kind": "event", "type": type, "key": key, "payload": payload, "objects": list(objects)}
    if ts is not None:
        m["ts"] = ts
    return m


class CoreError(Exception):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.body = body


class Client:
    def __init__(self, base_url: str, token: str, *, batch: int = 500, retries: int = 5, timeout: float = 60):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.batch = batch
        self.retries = retries
        self.timeout = timeout

    def _request(self, path: str, data: Optional[bytes] = None, content_type: Optional[str] = None) -> Any:
        """POSTs `data`, or GETs `path` when there is none; waits and retries when rate limited."""
        headers = {"Authorization": f"Bearer {self.token}"}
        if content_type:
            headers["Content-Type"] = content_type
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(self.base_url + path, data=data, method="POST" if data is not None else "GET", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return json.loads(r.read() or b"null")
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = raw.decode(errors="replace")
                if e.code == 429 and attempt < self.retries:
                    time.sleep(float(e.headers.get("Retry-After") or 2 ** attempt))
                    continue
                if e.code == 422 and isinstance(body, dict) and "rejected" in body:
                    return body  # every message refused: the reasons are in the body
                message = body.get("error", str(body)) if isinstance(body, dict) else str(body)
                raise CoreError(e.code, message, body) from None
        raise CoreError(429, "rate limited")

    def send(self, messages: list) -> dict:
        """Sends messages in batches. Returns accepted, rejected [{index, error}] and results
        [{index, id, status}] with indexes into `messages`."""
        out: dict[str, Any] = {"accepted": 0, "rejected": [], "results": []}
        for start in range(0, len(messages), self.batch):
            r = self._request("/api/push", json.dumps(messages[start:start + self.batch]).encode(), "application/json")
            out["accepted"] += r.get("accepted", 0)
            out["rejected"] += [{**x, "index": x["index"] + start} for x in r.get("rejected", [])]
            out["results"] += [{**x, "index": x["index"] + start} for x in r.get("results", [])]
        return out

    def send_csv(self, type: str, path_or_text: str) -> dict:
        """A CSV of objects of `type`: external_id, name, link.<key>, properties (prop.sub inside
        an object property), default.<prop>."""
        text = open(path_or_text, encoding="utf-8").read() if os.path.exists(path_or_text) else path_or_text
        return self._request(f"/api/push?type={quote(type)}", text.encode(), "text/csv")

    def attach(self, file: Union[str, bytes], to: Ref, *, filename: Optional[str] = None, content_type: Optional[str] = None) -> dict:
        """Attaches a file to an object (an id or ref(type, external_id)). Returns documentId,
        objectId and status ("created" or "duplicate")."""
        if isinstance(file, str):
            filename = filename or os.path.basename(file)
            with open(file, "rb") as f:
                data = f.read()
        else:
            data = file
        filename = filename or "file"
        content_type = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        fields = {"objectId": to} if isinstance(to, str) else {"type": to["type"], "externalId": to["externalId"]}
        boundary = uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                     f"Content-Type: {content_type}\r\n\r\n".encode() + data + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return self._request("/api/push/document", b"".join(parts), f"multipart/form-data; boundary={boundary}")

    def iter_results(self, filter: Union[dict, str, None] = None, *, page_size: int = 1000) -> Iterator[dict]:
        """The results of the token's project, with their reviews, page by page: each one is
        {id, externalId, name, properties, createdAt}. `filter` takes the project page's query,
        as a dict or a string: review, min, max (score), f.<key>, min.<key>, max.<key>, q, sort,
        order; e.g. {"review": "interesting"} or "review=discarded&min=0.5"."""
        query = filter.lstrip("?") if isinstance(filter, str) else urlencode(filter or {})
        offset = 0
        while True:
            page = self._request(f"/api/research/results?{query}{'&' if query else ''}offset={offset}&limit={page_size}")
            yield from page["results"]
            offset += len(page["results"])
            if not page["results"] or offset >= page["total"]:
                return

    def get_results(self, filter: Union[dict, str, None] = None, *, page_size: int = 1000) -> list:
        """Every result iter_results gives, as a list: what a retraining reads back."""
        return list(self.iter_results(filter, page_size=page_size))

"""The client against a stand-in server: batches, 429 retry, multipart, CSV and reading results back."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from vdx_core_client import Client, CoreError, event, obj, ref

seen = []
limited = {"n": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        seen.append((self.path, self.headers["Content-Type"], self.headers["Authorization"], body))
        if self.headers["Authorization"] != "Bearer t0k":
            return self.reply(401, {"error": "invalid source token"})
        if self.path == "/api/push" and limited["n"]:
            limited["n"] -= 1
            self.send_response(429)
            self.send_header("Retry-After", "0")
            self.end_headers()
            return
        if self.path.startswith("/api/push/document"):
            return self.reply(201, {"documentId": "d1", "objectId": "o1", "status": "created"})
        if self.path.startswith("/api/push?type="):
            return self.reply(200, {"accepted": 1, "rejected": [], "results": [{"index": 0, "id": "o1", "status": "created"}]})
        msgs = json.loads(body)
        self.reply(200, {"accepted": len(msgs), "rejected": [], "results": [{"index": i, "id": str(i), "status": "created"} for i in range(len(msgs))]})

    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        u = urlparse(self.path)
        seen.append((self.path, None, self.headers["Authorization"], b""))
        if u.path != "/api/research/results":
            return self.reply(404, {"error": "not found"})
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        rows = [{"id": str(i), "externalId": f"tic-{i}", "properties": {"review": q.get("review", "to_review")}} for i in range(5)]
        offset, limit = int(q["offset"]), int(q["limit"])
        self.reply(200, {"total": len(rows), "offset": offset, "limit": limit, "results": rows[offset:offset + limit]})

    def reply(self, status, data):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        seen.clear()

    def test_batches_and_indexes(self):
        core = Client(self.url, "t0k", batch=2)
        msgs = [obj("custom.result", f"tic-{i}", properties={"score": i}) for i in range(5)]
        r = core.send(msgs)
        self.assertEqual(len(seen), 3)
        self.assertEqual(r["accepted"], 5)
        self.assertEqual([x["index"] for x in r["results"]], [0, 1, 2, 3, 4])

    def test_waits_when_rate_limited(self):
        limited["n"] = 2
        r = Client(self.url, "t0k").send([event("custom.run", key="k", payload={}, objects=[ref("custom.project", "p")])])
        self.assertEqual(r["accepted"], 1)
        self.assertEqual(len(seen), 3)
        self.assertEqual(json.loads(seen[-1][3])[0]["objects"], [{"type": "custom.project", "externalId": "p"}])

    def test_attach_and_csv(self):
        core = Client(self.url, "t0k")
        self.assertEqual(core.attach(b"\x89PNG", ref("custom.result", "tic-1"), filename="lc.png")["status"], "created")
        path, ctype, _, body = seen[-1]
        self.assertTrue(ctype.startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="externalId"\r\n\r\ntic-1', body)
        self.assertIn(b"Content-Type: image/png", body)
        core.send_csv("custom.result", "external_id,score\ntic-1,0.5\n")
        self.assertEqual(seen[-1][:2], ("/api/push?type=custom.result", "text/csv"))

    def test_errors(self):
        with self.assertRaises(CoreError) as e:
            Client(self.url, "bad").send([obj("custom.result", "x")])
        self.assertEqual(e.exception.status, 401)


    def test_get_results_pages(self):
        core = Client(self.url, "t0k")
        rows = core.get_results({"review": "interesting", "f.extra.gene": "BRCA1"}, page_size=2)
        self.assertEqual([r["externalId"] for r in rows], [f"tic-{i}" for i in range(5)])
        self.assertTrue(all(r["properties"]["review"] == "interesting" for r in rows))
        self.assertEqual(len(seen), 3)
        self.assertIn("f.extra.gene=BRCA1", seen[0][0])
        self.assertEqual(seen[0][2], "Bearer t0k")
        self.assertEqual(len(core.get_results("review=discarded")), 5)
        self.assertTrue(seen[-1][0].startswith("/api/research/results?review=discarded&offset=0"))


if __name__ == "__main__":
    unittest.main()

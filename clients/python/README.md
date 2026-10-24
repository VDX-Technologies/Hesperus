# vdx-core-client

Sends a program's output to VDX Core through a push source of the tenant's own types (module
`custom`). Standard library only.

```python
from vdx_core_client import Client, obj, event, ref

core = Client("https://core.example.com", token=os.environ["VDX_TOKEN"])

# the run: the key is yours and stays the same when the same run is sent again
run = core.send([event("custom.run", key=f"{commit}:S70", payload={"commit": commit, "items": 18000, "outcome": "ok"},
                       objects=[PROJECT_ID, ref("custom.dataset", "S70")])])
run_id = run["results"][0]["id"]

# the results, matched by external id: sending them again updates them, a review made in Core stays
core.send([obj("custom.result", f"tic-{tic}", name=f"TIC {tic}", properties={"score": s, "run": int(run_id), "extra": {"tic_id": tic}},
               defaults={"review": "to_review"}) for tic, s in found])

# a plot attached to a result: the same file sent again is the same document
core.attach("plots/tic-123.png", ref("custom.result", "tic-123"))

# or a CSV of results (external_id, name, score, extra.tic_id, default.review, link.<key>)
core.send_csv("custom.result", "results.csv")
```

The source's token only reaches its project: results are linked to it, other projects' objects
are refused. `send` splits long lists in batches and waits when Core asks to (429).

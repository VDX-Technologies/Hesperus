# Contributing

Thanks for your interest in VDX Core!

1. Fork the repo and create a branch from `main`.
2. Set up the project as described in the [README](README.md).
3. Make your change, with tests where it makes sense.
4. Run `npm run lint && npm test && npm run build` before opening a pull request.
5. Describe what changed and why in the PR.

Database changes go in a new file under `supabase/migrations/` (never edit an existing
migration). See [ARCHITECTURE.md](ARCHITECTURE.md) for how the engine and modules fit together.

By contributing you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE).

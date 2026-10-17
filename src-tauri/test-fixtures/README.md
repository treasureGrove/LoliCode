# Resource-pack fixtures

`resource-packs.json` contains a synthetic 1×1 PNG, ZIP variants, an ephemeral test public key and detached signatures. The private key existed only in the generator process memory and was not saved. These fixtures do not contain production signing keys, model API keys or user data. Malformed variants exercise compatibility, path, entry-type and integrity rejection by the production verifier.

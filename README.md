# OSS Assistant Static Config

This repository contains the public OSS Assistant static config package.

It includes recycle configuration JSON, image assets, and the static recycle configurator. It must not contain secrets, tokens, customer data, or the full extension source.

After GitHub Pages is enabled, the static configurator is expected under `/configurator/`.

Full validation is performed by local scripts in the extension repository, or by a future GitHub Action. The extension runtime does not load remote config yet.

# One CUDA per machine

A torch wheel brings its CUDA libraries along as `nvidia-*` packages, about 3 GiB for a CUDA 13
build, and torch itself about 1 GiB more. Every venv that installs them on its own carries its own
copy. This document is the rule every project that puts a torch venv on a machine of the deployment
follows, this repository's Laya venvs and the projects of other repositories alike, so that a machine
holds torch and its CUDA libraries once.

## The rule

- **Every torch venv on the machine is made by uv,** never by pip: uv unpacks each wheel once into
  its cache and links every venv's files to the cache's, so the cache and each venv share one copy
  of every file on disk.
- **From the account's one uv cache,** uv's own default under the account's home, on the same
  filesystem as the venvs: a link cannot cross filesystems, and a venv elsewhere gets a copy.
- **With links, never copies:** the setup asks uv for hard links by name rather than leaning on its
  default, and reads back that it got them (「How it is checked」).
- **On the same torch:** only identical wheels share. torch pins the exact `nvidia-*` versions it
  needs, so two venvs on the same torch version and the same CUDA build share every one of them.
  - The machine's torch is the one Laya pins in the decision server's project file, built for the CUDA its
    driver runs (uv's torch backend `auto`).
  - Another project on the machine pins that same torch version and installs it with the same
    backend. One that cannot run on it keeps its own copy and says why in its own documents.

## What a machine keeps

- **The uv cache stays.** Clearing it frees nothing the venvs still link to, and the next venv made
  after it downloads every wheel afresh, a second copy beside the first.
- **uv's own folder under `~/.local/share/uv` stays.** It holds the interpreter every venv here
  stands on; without it every venv on the machine is left without its Python.
- **Space is taken back by removing a venv no longer used,** never the cache: what the venv shares
  stays for as long as the cache or another venv links it.

## How it is checked

- **A file's link count says it is shared:** a CUDA library in a venv that shares it shows two links
  or more, one for the cache and one for each venv. Laya's setup says the count of its largest CUDA
  library as it ends (`docs/training.md`, 「The nodes」).
- **One `du` over the cache and every venv together** counts a shared file once, and is the machine's
  real figure; a `du` over each folder alone counts it in each.

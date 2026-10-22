# Install Arc

Arc releases contain the terminal application and independent library archives. Installation requires Node.js 22.19 or later and npm. Third-party dependencies require access to the npm registry or a populated npm cache.

## Install a release

Extract the release archive. From the extracted directory, run:

```sh
node scripts/install.mjs --source . --prefix "$HOME/.local/share/arc"
```

The installer verifies archive checksums and checks that native binaries match your operating system and architecture. It installs into a dedicated directory. It refuses an existing unowned directory.

Add the launch directory to your shell's PATH:

```sh
export PATH="$HOME/.local/share/arc/bin:$PATH"
arc --help
arc
```

On Windows, pass a Windows installation path to the Node installer and add its `bin` directory to PATH. That directory contains `arc.cmd`. Native acceptance on a platform requires a test on that platform.

Inside Arc, use `/login` to authenticate and choose a model, `/model` to change it later, and `/help` to list commands. Arc stores settings, credentials, and sessions under `~/.arc` by default.

## Replace an installation

Close the running Arc process. Remove the previous owned installation, then install the new release:

```sh
node scripts/uninstall.mjs --prefix "$HOME/.local/share/arc"
node scripts/install.mjs --source . --prefix "$HOME/.local/share/arc"
```

Uninstalling the application preserves `~/.arc`. Removing that directory is a separate action that can delete credentials and conversation history.

## Remove Arc

```sh
node scripts/uninstall.mjs --prefix "$HOME/.local/share/arc"
```

The uninstaller refuses unowned directories and symlink installation prefixes. If you created another launcher symlink outside the installation, remove that symlink separately.

## Use the libraries

The release's `packages` directory contains workspace archives. The accompanying `package.json` uses local file dependencies. Run `npm install` in the extracted release to use those libraries, or copy the archives and their dependency entries into your Node application. No npm publication is required.

Each installed package includes its own README and specification. The source checkout also contains the complete documentation index in docs/README.md.

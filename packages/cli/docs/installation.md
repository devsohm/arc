# Install and remove an archive release

Arc requires Node.js 22.19.0 or newer and npm. A prepared release contains `package.json`, `release.json`, `SHA256SUMS`, local archives in `packages/`, and the installer scripts in `scripts/`. Use a release containing native binaries for your operating system and CPU architecture.

After downloading and extracting a release, run its installer with the release folder and a dedicated installation directory. The directory must not already exist unless it contains the identical release installed by this script.

```sh
node /path/to/release/scripts/install.mjs \
	--source /path/to/release \
	--prefix "$HOME/.local/share/arc"
```

Linux and macOS also have a shell wrapper:

```sh
sh /path/to/release/scripts/install.sh \
	--source /path/to/release \
	--prefix "$HOME/.local/share/arc"
```

Add the installation's `bin` directory to your shell's `PATH`, then run `arc --help`. For the example prefix, the directory is `$HOME/.local/share/arc/bin`. On Windows, call the Node script with Windows paths and add the prefix's `bin` directory to `PATH`. The installer creates `arc.cmd` there.

The installer checks archive SHA-256 digests and release target metadata before creating the installation. It copies the archives into the installation and runs npm with lifecycle scripts disabled. The extracted download can then be removed. Repeating the same installation leaves it unchanged. A different release requires removing the existing installation first.

## Offline use

The release includes the local workspace archives. Their third-party dependencies still require npm's registry or an existing npm cache. To prohibit registry access, add `--offline`:

```sh
node /path/to/release/scripts/install.mjs \
	--source /path/to/release \
	--prefix "$HOME/.local/share/arc" \
	--offline
```

An offline installation fails if npm cannot resolve a dependency from the supplied archives or its cache. The installer does not publish packages to npm.

## Remove the application

Use the uninstaller from an extracted release or the source checkout:

```sh
node /path/to/release/scripts/uninstall.mjs \
	--prefix "$HOME/.local/share/arc"
```

The shell equivalent is `sh /path/to/release/scripts/uninstall.sh --prefix "$HOME/.local/share/arc"`.

The uninstaller requires the installation's ownership marker before removing the dedicated installation tree and launcher. It refuses unowned directories and symlink prefixes. Repeating removal after the directory is gone succeeds without changes.

Credentials, settings, and sessions in `~/.arc` remain on disk. The scripts reject an installation prefix that contains `~/.arc`. Keep any custom application data directory outside the installation prefix. There is no purge option.

An ordinary installation failure removes the newly created installation directory. A killed installer may leave an incomplete directory without an ownership marker. The scripts refuse that directory, so inspect it before removing it manually.

## Verified platforms

The installer tests pack and install real local fixture archives through npm on Linux, execute the installed command, rerun the installer, and remove the owned tree. They also verify shell wrappers, paths with spaces and punctuation, checksum rejection, target rejection, and protection of unrelated files. These tests do not establish full Arc runtime acceptance. macOS and Windows native installation and runtime acceptance remain unverified.

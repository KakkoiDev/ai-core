// A macOS sandbox-exec profile for running a coding agent on one folder, as hardened by benching (2026-11-24/25):
// - SBPL: the last matching rule wins, and an `allow file-read*` does not undo a more specific
//   `deny file-read-data`, so deny with file-read*;
// - node needs metadata of the working folder's parents and the per-user cache folder
//   (`getconf DARWIN_USER_CACHE_DIR`) at start-up;
// - the shared /tmp held other runs' solutions an agent found and read: each run gets its own temp folder;
// - the agent only needs its model's port: limit outbound network to it.

/** Folders under the home folder no agent should read, even when its workspace is above them. */
export const SECRET_PATHS = [".ssh", ".gnupg", ".aws", ".config/gh", ".config/deepseek", ".netrc", ".docker/config.json",
  ".kube", "Library/Keychains", ".pi/agent/auth.json", ".git-credentials"];

const q = (p) => '"' + String(p).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

/**
 * @param {object} o
 * @param {string} o.home        the user's home folder: nothing in it is readable except what is listed
 * @param {string[]} o.writable  folders the agent may write (and read): its workspace, session folder, temp folder
 * @param {string[]} [o.readable] more folders or files it may read (the tools it runs, git config, ...)
 * @param {string} [o.tmp]       its private temp folder (the rest of /tmp and /private/var/folders is closed)
 * @param {string} [o.cache]     the per-user cache folder node needs
 * @param {number|null} [o.port] the only localhost port it may reach (null: unix sockets only)
 * @param {boolean} [o.net]      allow all outbound network
 * @param {string[]} [o.secrets] home-relative paths never readable (default SECRET_PATHS)
 */
export function macSandboxProfile({ home, writable, readable = [], tmp, cache, port = null, net = false, secrets = SECRET_PATHS }) {
  const w = [...writable, tmp, cache].filter(Boolean);
  const L = ["(version 1)", "; the last matching rule wins", "(allow default)", "",
    "(deny file-write*)",
    "(allow file-write*", ...w.map((p) => `  (subpath ${q(p)})`),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/ptmx") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/pty"))', "",
    `(deny file-read* (subpath ${q(home)}))`,
    "(allow file-read*", ...[...w, ...readable].map((p) => `  (subpath ${q(p)})`), ")",
    `(allow file-read-metadata (subpath ${q(home)}))   ; node resolves the working folder through its parents`, "",
    "(deny file-read* file-write*", ...secrets.map((s) => `  (subpath ${q(home + "/" + s)})`), ")", ""];
  if (tmp) {
    L.push("; the shared temp folders hold other programs' files: only this run's own",
      '(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))',
      '(allow file-read-metadata (literal "/private/tmp") (literal "/tmp") (literal "/private/var/folders"))',
      `(allow file-read* file-write* ${[tmp, cache].filter(Boolean).map((p) => `(subpath ${q(p)})`).join(" ")})`, "");
  }
  if (!net) L.push("(deny network-outbound)", "(allow network-outbound (remote unix-socket)" + (port ? ` (remote ip "localhost:${port}")` : "") + ")");
  return L.join("\n") + "\n";
}

/** True when `dir` is the home folder or contains it: an agent run there could reach everything. */
export function holdsHome(dir, home) {
  const d = dir.replace(/\/+$/, "") || "/", h = home.replace(/\/+$/, "");
  return d === h || h.startsWith(d === "/" ? "/" : d + "/");
}

#!/usr/bin/env python3
"""
AgentSonar OMA sidecar — bridges OMA trace events to AgentSonar's engine.

Listens on localhost:8787 for four endpoints:
    POST /ingest   — {source, target, timestamp, metadata}
                     Calls sonar.delegation(source, target).
    POST /trace    — TraceEvent JSON (OMA's `agent` or `task` events).
                     Stashed for future per-agent cost aggregation.
    POST /shutdown — Triggers sonar.shutdown() (writes report.json +
                     report.html), then exits the process.
    GET  /health   — Liveness check + current event/alert counts.

Start before running your OMA app:
    python sidecar/sidecar.py                               # all defaults
    python sidecar/sidecar.py --warning-threshold 3 --critical-threshold 8

See `python sidecar/sidecar.py --help` for the full list of overridable
detection thresholds. Every flag also has an env-var fallback so it works
in Docker / CI:  AGENTSONAR_WARNING_THRESHOLD=3 python sidecar/sidecar.py

Reports land under `agentsonar_logs/run-<slug>/` in the current working
directory (override with --log-dir).

Ctrl-C also triggers shutdown cleanly.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agentsonar import PreventError, monitor_orchestrator

# ----------------------------------------------------------------------
# CLI config — env var fallbacks documented inline. Resolution order:
#     CLI flag > env var > SDK default.
# We parse BEFORE constructing the sonar instance so config takes effect.
# ----------------------------------------------------------------------

def _env(name: str, default: str | None = None) -> str | None:
    """Read env var, returning default if absent or empty."""
    val = os.environ.get(name, "")
    return val if val else default


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="agentsonar-sidecar",
        description=(
            "AgentSonar OMA sidecar. Detection thresholds default to the "
            "AgentSonar SDK's defaults; override with the flags below."
        ),
    )
    p.add_argument(
        "--port", type=int,
        default=int(_env("AGENTSONAR_PORT", "8787") or "8787"),
        help="HTTP port to listen on (env: AGENTSONAR_PORT). Default: 8787.",
    )
    p.add_argument(
        "--log-dir", type=str,
        default=_env("AGENTSONAR_LOG_DIR", "."),
        help=(
            "Where agentsonar_logs/ lands (env: AGENTSONAR_LOG_DIR). "
            "Default: current working directory."
        ),
    )

    alert = p.add_argument_group(
        "alert thresholds",
        description=(
            "Rotation/event counts AT which a cyclic_delegation or "
            "repetitive_delegation alert fires. Inclusive — `>=` "
            "comparison. `--warning-threshold 5` means rotation 5 is the "
            "first WARNING (rotation 4 is still clean). Same convention "
            "as LangGraph's `recursion_limit`."
        ),
    )
    alert.add_argument(
        "--warning-threshold", type=int,
        default=int(_env("AGENTSONAR_WARNING_THRESHOLD", "5") or "5"),
        help=(
            "Rotation count AT which WARNING fires (inclusive `>=`). "
            "Default: 5 — i.e. rotation 5 is the trigger, not rotation 6. "
            "Env: AGENTSONAR_WARNING_THRESHOLD."
        ),
    )
    alert.add_argument(
        "--critical-threshold", type=int,
        default=int(_env("AGENTSONAR_CRITICAL_THRESHOLD", "15") or "15"),
        help=(
            "Rotation count AT which CRITICAL fires (inclusive `>=`). "
            "Default: 15 — i.e. rotation 15 IS the trigger, not 16. "
            "Env: AGENTSONAR_CRITICAL_THRESHOLD."
        ),
    )
    alert.add_argument(
        "--resolve-after", type=float,
        default=float(_env("AGENTSONAR_RESOLVE_AFTER", "60.0") or "60.0"),
        help="Seconds of inactivity before an alert auto-resolves. Default: 60.",
    )

    rate = p.add_argument_group(
        "rate limiter (resource_exhaustion)",
        description="Controls when bursty edge traffic fires resource_exhaustion.",
    )
    rate.add_argument(
        "--window-size", type=float,
        default=float(_env("AGENTSONAR_WINDOW_SIZE", "180.0") or "180.0"),
        help="Sliding window in seconds (env: AGENTSONAR_WINDOW_SIZE). Default: 180.",
    )
    rate.add_argument(
        "--per-edge-limit", type=int,
        default=int(_env("AGENTSONAR_PER_EDGE_LIMIT", "10") or "10"),
        help="Max events on one edge in window (env: AGENTSONAR_PER_EDGE_LIMIT). Default: 10.",
    )
    rate.add_argument(
        "--global-limit", type=int,
        default=int(_env("AGENTSONAR_GLOBAL_LIMIT", "200") or "200"),
        help="Max total events in window (env: AGENTSONAR_GLOBAL_LIMIT). Default: 200.",
    )

    decay = p.add_argument_group(
        "repetition detector",
        description="Exponential-decay anomaly detector (repetitive_delegation).",
    )
    decay.add_argument(
        "--half-life", type=float,
        default=float(_env("AGENTSONAR_HALF_LIFE", "180.0") or "180.0"),
        help="Half-life in seconds (env: AGENTSONAR_HALF_LIFE). Default: 180.",
    )
    decay.add_argument(
        "--z-score-threshold", type=float,
        default=float(_env("AGENTSONAR_Z_SCORE_THRESHOLD", "3.0") or "3.0"),
        help="Z-score to fire repetitive_delegation. Default: 3.0.",
    )

    prevent = p.add_argument_group(
        "prevent mode",
        description=(
            "Opt-in 'circuit breaker' mode. When the engine detects a "
            "tracked failure (currently only cyclic_delegation) crossing "
            "the trip threshold, the next /ingest request is answered "
            "with HTTP 409 + RFC 7807 Problem Details so the TypeScript "
            "client can throw PreventError into the user's code. Without "
            "these flags, the sidecar runs in pure detection mode."
        ),
    )
    prevent.add_argument(
        "--prevent-cyclic-delegation", action="store_true",
        default=_env("AGENTSONAR_PREVENT_CYCLIC_DELEGATION", "").lower()
        in ("1", "true", "yes", "on"),
        help=(
            "Enable Prevent Mode for cyclic_delegation. Default trip "
            "behavior is on CRITICAL severity. Env: "
            "AGENTSONAR_PREVENT_CYCLIC_DELEGATION."
        ),
    )
    prevent.add_argument(
        "--prevent-max-rotations", type=int,
        default=(
            int(_env("AGENTSONAR_PREVENT_MAX_ROTATIONS", "") or "0") or None
        ),
        help=(
            "Trip Prevent Mode at exactly this rotation count instead of "
            "waiting for CRITICAL severity. Only meaningful with "
            "--prevent-cyclic-delegation. Env: "
            "AGENTSONAR_PREVENT_MAX_ROTATIONS."
        ),
    )

    out = p.add_argument_group("output")
    out.add_argument(
        "--no-console", action="store_true",
        help="Disable alert streaming to stderr. Default: enabled.",
    )
    out.add_argument(
        "--no-report", action="store_true",
        help="Disable HTML/JSON report write on shutdown. Default: enabled.",
    )
    out.add_argument(
        "--report-title", type=str,
        default=_env("AGENTSONAR_REPORT_TITLE", "AgentSonar Report"),
        help='HTML report title. Default: "AgentSonar Report".',
    )

    return p


def _cli_to_config(args: argparse.Namespace) -> dict:
    """Translate parsed argparse namespace to the SDK's config dict.

    Only includes keys the user overrode or the SDK expects by name — keeps
    the dict minimal so the SDK's own defaults apply where we didn't touch.
    """
    cfg: dict = {
        "log_dir": args.log_dir,
        "warning_threshold": args.warning_threshold,
        "critical_threshold": args.critical_threshold,
        "resolve_after_seconds": args.resolve_after,
        "window_size": args.window_size,
        "per_edge_limit": args.per_edge_limit,
        "global_limit": args.global_limit,
        "half_life_seconds": args.half_life,
        "z_score_threshold": args.z_score_threshold,
        "console_output": not args.no_console,
        "file_output": not args.no_report,
        "report_title": args.report_title,
    }
    # Prevent Mode (opt-in). Only attach the prevent dict when the user
    # explicitly enabled it; otherwise the SDK runs in pure detection mode.
    if args.prevent_cyclic_delegation:
        if args.prevent_max_rotations is not None:
            cfg["prevent"] = {
                "cyclic_delegation": {"max_rotations": args.prevent_max_rotations}
            }
        else:
            cfg["prevent"] = {"cyclic_delegation": True}
    return cfg


# Parse CLI at import time so `sonar` is constructed with the right config
# before any request arrives. `parse_args()` will sys.exit on --help.
_args = _build_arg_parser().parse_args()
_config = _cli_to_config(_args)

# ----------------------------------------------------------------------
# State
# ----------------------------------------------------------------------

sonar = monitor_orchestrator(_config)

# ThreadingHTTPServer dispatches requests on concurrent threads. The
# AgentSonar engine's internal graph/detector state isn't guaranteed to
# be thread-safe, so we serialize all calls into it behind this lock.
# Delegation calls are fast (microseconds), so the lock doesn't become
# a bottleneck even under concurrent POST /ingest requests.
_sonar_lock = threading.Lock()

# Stash raw trace events for future per-agent cost rollups. We don't
# process them in v1 — just persist so the Python-side feature work can
# pull them later from the same sidecar run.
#
# Bounded by `_MAX_TRACE_EVENTS` so a long-running sidecar can't leak
# memory. `deque(maxlen=N)` evicts the oldest entry on overflow in O(1),
# which is the right behavior for telemetry buffers — newest events are
# usually more relevant for debugging than oldest. Counts are FIFO-evicted
# silently; the sidecar's stderr print on shutdown reports the final size.
_MAX_TRACE_EVENTS = 10_000
_trace_events: deque[dict] = deque(maxlen=_MAX_TRACE_EVENTS)
_trace_events_lock = threading.Lock()

# Cap request body size. localhost-only deployment makes this mostly
# defensive (the TS client can't realistically send GBs), but a buggy
# client sending content-length: 1_000_000_000 should not OOM the
# sidecar. 1 MB is generous for delegation events and trace events,
# both of which are <1 KB in practice.
_MAX_BODY_BYTES = 1 * 1024 * 1024

_shutdown_started = False
_shutdown_lock = threading.Lock()


# ----------------------------------------------------------------------
# Handlers
# ----------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """
    Minimal HTTP handler. Uses threading.Lock on shared state because
    BaseHTTPRequestHandler is single-threaded by default, but we run it
    via ThreadingHTTPServer to avoid head-of-line blocking when the OMA
    client fires multiple POSTs in parallel.
    """

    # --- Response helpers -------------------------------------------------

    def _check_body_size(self) -> bool:
        """Return True if Content-Length is within `_MAX_BODY_BYTES`. If not,
        respond 413 (Payload Too Large) and return False — caller should not
        proceed to read the body. Prevents a buggy or malicious client from
        OOM-ing the sidecar by claiming a giant content length.
        """
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self._respond(400, b'{"error":"invalid content-length"}')
            return False
        if length > _MAX_BODY_BYTES:
            self._respond(413, b'{"error":"payload too large"}')
            return False
        return True

    def _json_body(self) -> dict:
        # Caller must call _check_body_size() FIRST. This method is permissive
        # by design — bad input maps to {} so handlers can return clean 400s
        # via their own validation.
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            parsed = json.loads(raw)
        except Exception:
            return {}
        # json.loads can return list/str/int/float/bool/None — not just dict.
        # Callers use body.get("..."), so we need a dict. Non-dicts → {}.
        return parsed if isinstance(parsed, dict) else {}

    def _respond(self, status: int = 204, body: bytes | None = None) -> None:
        self.send_response(status)
        if body is not None:
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body is not None:
            self.wfile.write(body)

    def _respond_prevent(self, exc: PreventError) -> None:
        """Respond 409 + RFC 7807 Problem Details when Prevent Mode trips.

        The TS client looks for `status==409 + content-type
        application/problem+json + body.agentsonar` to decide whether to
        throw PreventError into the user's code. All three guards must
        line up so a misconfigured proxy returning 409 from somewhere
        else can't accidentally trip the client's exception path.

        See: docs/problems/coordination-prevented.md
        """
        body_obj = {
            "type": (
                "https://github.com/agentsonar/agentsonar/blob/main/"
                "docs/problems/coordination-prevented.md"
            ),
            "title": "Coordination Failure Prevented",
            "status": 409,
            "detail": exc.reason,
            "instance": "/ingest",
            "agentsonar": {
                "failure_class": exc.failure_class,
                "severity": exc.severity,
                "rotations": exc.rotations,
                "cycle_path": list(exc.cycle_path),
                "reason": exc.reason,
                "timestamp": exc.timestamp,
            },
        }
        body = json.dumps(body_obj).encode("utf-8")
        self.send_response(409)
        self.send_header("content-type", "application/problem+json")
        self.send_header("content-length", str(len(body)))
        # Discourage caching of this informational state response.
        self.send_header("cache-control", "no-cache, no-store")
        # Cheap observability for proxy/log debugging - the prevent
        # cause is visible without parsing the body.
        self.send_header("x-agentsonar-prevent", exc.failure_class)
        self.end_headers()
        self.wfile.write(body)

    # --- Endpoints --------------------------------------------------------

    def do_POST(self) -> None:
        if self.path == "/ingest":
            self._handle_ingest()
        elif self.path == "/trace":
            self._handle_trace()
        elif self.path == "/shutdown":
            self._handle_shutdown()
        else:
            self._respond(404, b'{"error":"unknown endpoint"}')

    def do_GET(self) -> None:
        # /health for liveness checks (useful during local dev)
        if self.path in ("/", "/health"):
            summary = sonar.get_summary()
            body = json.dumps({
                "status": "ok",
                "events_ingested": summary.get("total_events", 0),
                "alerts_raised": summary.get("alerts_raised", 0),
                "trace_events_stashed": len(_trace_events),
            }).encode("utf-8")
            self._respond(200, body)
        else:
            self._respond(404)

    def _handle_ingest(self) -> None:
        if not self._check_body_size():
            return
        body = self._json_body()
        source = body.get("source")
        target = body.get("target")
        if not source or not target:
            self._respond(400, b'{"error":"missing source/target"}')
            return
        try:
            # Serialize engine access; the SDK's internal graph/detector
            # state isn't guaranteed thread-safe. Delegation is fast, so
            # serializing concurrent POSTs doesn't become a bottleneck.
            with _sonar_lock:
                sonar.delegation(source=source, target=target)
        except PreventError as e:
            # Prevent Mode tripped. Return a structured 409 so the TS
            # client can throw PreventError into the user's code.
            # This is the ONLY exception type the sidecar surfaces as
            # a non-2xx response — every other exception is swallowed
            # to preserve the host-safety contract.
            self._respond_prevent(e)
            return
        except Exception as e:
            # Host-safety principle from the SDK: never crash on bad input
            sys.stderr.write(f"[sidecar] delegation() threw: {e}\n")
        self._respond()

    def _handle_trace(self) -> None:
        if not self._check_body_size():
            return
        body = self._json_body()
        # Minimal validation — only accept the event shapes we know about
        evt_type = body.get("type")
        if evt_type not in ("agent", "task", "llm_call", "tool_call"):
            self._respond(400, b'{"error":"unknown trace type"}')
            return
        with _trace_events_lock:
            _trace_events.append(body)
        self._respond()

    def _handle_shutdown(self) -> None:
        if not self._check_body_size():
            return
        global _shutdown_started
        with _shutdown_lock:
            if _shutdown_started:
                self._respond(200, b'{"status":"already shutting down"}')
                return
            _shutdown_started = True
        trace_count = len(_trace_events)
        sys.stderr.write(
            f"[sidecar] shutdown requested. "
            f"Captured {trace_count} trace events.\n"
        )
        # Respond BEFORE shutting down so the client gets an ACK.
        body = json.dumps({
            "status": "shutting down",
            "trace_events_stashed": trace_count,
        }).encode("utf-8")
        self._respond(200, body)
        # Schedule the actual shutdown on a background thread so this
        # handler can return cleanly.
        threading.Thread(target=_do_shutdown, daemon=True).start()

    def log_message(self, fmt: str, *args) -> None:
        # Silence default-HTTPServer access logging. Uncomment if you
        # want to see every request during debugging.
        return


def _do_shutdown() -> None:
    # Small delay so the HTTP response can flush to the client before
    # we tear down the process. Practical; not necessary for correctness.
    time.sleep(0.2)
    try:
        with _sonar_lock:
            sonar.shutdown()
    except Exception as e:
        sys.stderr.write(f"[sidecar] sonar.shutdown() threw: {e}\n")
    # Print the report path so the user doesn't have to hunt for it.
    # Wrapped in try/except because attribute chains into internal SDK
    # state can raise AttributeError if SDK layout changes, and we must
    # never crash here — we're already shutting down.
    try:
        run_dir = getattr(
            getattr(getattr(sonar, "engine", None), "logger", None),
            "run_dir",
            None,
        )
        if run_dir:
            sys.stderr.write(
                f"[sidecar] Report written to {run_dir}/report.html\n"
            )
    except Exception as e:
        sys.stderr.write(f"[sidecar] could not resolve report path: {e}\n")
    # Flush stdio so our messages reach the terminal before the process
    # disappears (os._exit skips normal cleanup including buffer flush).
    try:
        sys.stderr.flush()
        sys.stdout.flush()
    except Exception:
        pass
    # CRITICAL: use os._exit, NOT sys.exit.
    #
    # This function runs on a background thread (spawned in
    # _handle_shutdown). sys.exit() raises SystemExit in the current
    # thread; in a non-main thread that only terminates the thread, not
    # the process — the main thread would keep serving on the HTTP port
    # and the user would be stuck unable to return to their prompt.
    #
    # os._exit() forces process termination from any thread by calling
    # the OS-level _exit syscall. It skips atexit handlers and any
    # stdio cleanup, but we already ran sonar.shutdown() and flushed
    # stdio above, so nothing is lost.
    os._exit(0)


# ----------------------------------------------------------------------
# Ctrl-C handler
# ----------------------------------------------------------------------

def _signal_handler(signum, frame):
    global _shutdown_started
    with _shutdown_lock:
        if _shutdown_started:
            return
        _shutdown_started = True
    sys.stderr.write("\n[sidecar] Ctrl-C received. Writing report...\n")
    _do_shutdown()


def main() -> None:
    port = _args.port
    server = ThreadingHTTPServer(("localhost", port), Handler)

    signal.signal(signal.SIGINT, _signal_handler)
    # SIGTERM handler for container-friendly shutdown. Windows doesn't
    # fully support it but setting is harmless.
    try:
        signal.signal(signal.SIGTERM, _signal_handler)
    except (AttributeError, ValueError):
        pass

    sys.stderr.write(f"AgentSonar OMA sidecar listening on http://localhost:{port}\n")
    sys.stderr.write("  POST /ingest    — delegation events\n")
    sys.stderr.write("  POST /trace     — OMA trace events (stashed for cost work)\n")
    sys.stderr.write("  POST /shutdown  — write report.html + exit\n")
    sys.stderr.write("  GET  /health    — liveness + current counts\n")
    sys.stderr.write(
        f"[sidecar] config: warning={_args.warning_threshold}  "
        f"critical={_args.critical_threshold}  "
        f"per_edge_limit={_args.per_edge_limit}  "
        f"window={_args.window_size}s  "
        f"half_life={_args.half_life}s\n"
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _signal_handler(None, None)


if __name__ == "__main__":
    main()

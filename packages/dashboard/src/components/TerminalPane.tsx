import type { Cast, CastEvent } from "@agentrec/core/browser";
import { Terminal } from "@xterm/xterm";
import { type ReactElement, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { formatSeconds } from "../lib/format";
import { CastPlayer, fitFontSize, MONO_STACK, TERMINAL_THEME } from "../lib/terminal";
import "@xterm/xterm/css/xterm.css";

const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

/** Seconds of virtual time between scrubber/readout updates during playback. */
const REPORT_INTERVAL = 0.1;

export interface PlayerHandle {
  seek: (seconds: number) => void;
  togglePlay: () => void;
  appendLive: (event: CastEvent) => void;
}

export type CastStatus = "loading" | "ready" | "missing" | "error";

interface TerminalPaneProps {
  cast: Cast | null;
  status: CastStatus;
  live: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  handleRef: RefObject<PlayerHandle | null>;
}

interface Clock {
  /** Virtual time at the last commit, in seconds. */
  virtualT: number;
  /** performance.now() at the last commit. */
  wallStart: number;
}

export function TerminalPane(props: TerminalPaneProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<CastPlayer | null>(null);
  const clockRef = useRef<Clock>({ virtualT: 0, wallStart: 0 });
  const totalRef = useRef(0);
  const reportedRef = useRef(0);
  const followRef = useRef(props.follow);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(0);

  followRef.current = props.follow;

  const seek = useCallback((seconds: number) => {
    const player = playerRef.current;
    if (player === null) return;
    const target = Math.max(0, Math.min(seconds, totalRef.current));
    player.to(target);
    clockRef.current = { virtualT: target, wallStart: performance.now() };
    setElapsed(target);
  }, []);

  const togglePlay = useCallback(() => {
    if (followRef.current) return;
    setPlaying((current) => {
      if (current) return false;
      if (clockRef.current.virtualT >= totalRef.current) seek(0);
      return true;
    });
  }, [seek]);

  const appendLive = useCallback((event: CastEvent) => {
    const player = playerRef.current;
    player?.append(event);
    totalRef.current = Math.max(totalRef.current, event.t);
    const following = followRef.current;

    if (following) {
      const clock = clockRef.current;
      clock.virtualT = event.t;
      clock.wallStart = performance.now();
      player?.to(event.t);
    }

    // Bursty output would otherwise re-render the player bar per frame.
    if (event.t - reportedRef.current < REPORT_INTERVAL) return;
    reportedRef.current = event.t;
    setTotal(totalRef.current);
    if (following) setElapsed(event.t);
  }, []);

  useEffect(() => {
    props.handleRef.current = { seek, togglePlay, appendLive };
    return () => {
      props.handleRef.current = null;
    };
  }, [props.handleRef, seek, togglePlay, appendLive]);

  // Mount a terminal per cast and paint the final frame: a blank screen reads
  // as a broken player, and the end state is the most useful still.
  useEffect(() => {
    const host = hostRef.current;
    const cast = props.cast;
    if (host === null || cast === null) return;

    const term = new Terminal({
      cols: cast.header.width,
      rows: cast.header.height,
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: MONO_STACK,
      fontSize: 13,
      lineHeight: 1,
      scrollback: 2000,
      theme: TERMINAL_THEME,
    });
    term.open(host);

    const applyFit = (): void => {
      const size = fitFontSize(host.clientWidth, host.clientHeight, term.cols, term.rows);
      if (term.options.fontSize !== size) term.options.fontSize = size;
    };
    const player = new CastPlayer(term, cast, applyFit);
    playerRef.current = player;
    totalRef.current = player.duration;

    applyFit();
    const observer = new ResizeObserver(applyFit);
    observer.observe(host);

    setTotal(totalRef.current);
    setPlaying(false);
    seek(totalRef.current);

    return () => {
      observer.disconnect();
      player.dispose();
      playerRef.current = null;
      term.dispose();
    };
  }, [props.cast, seek]);

  useEffect(() => {
    if (!playing) return;
    const clock = clockRef.current;
    clock.wallStart = performance.now();
    let frame = 0;
    let reported = -1;

    const tick = (): void => {
      const player = playerRef.current;
      if (player === null) return;
      const t = clock.virtualT + ((performance.now() - clock.wallStart) / 1000) * speed;
      player.to(Math.min(t, totalRef.current));
      if (Math.abs(t - reported) >= REPORT_INTERVAL) {
        reported = t;
        setElapsed(Math.min(t, totalRef.current));
      }
      if (t >= totalRef.current) {
        setPlaying(false);
        setElapsed(totalRef.current);
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      const t = clock.virtualT + ((performance.now() - clock.wallStart) / 1000) * speed;
      clock.virtualT = Math.max(0, Math.min(t, totalRef.current));
      clock.wallStart = performance.now();
    };
  }, [playing, speed]);

  // Following a live session means the terminal is a tail, not a player.
  useEffect(() => {
    if (!props.follow) return;
    setPlaying(false);
    seek(totalRef.current);
  }, [props.follow, seek]);

  const atEnd = !playing && elapsed >= total && total > 0;

  return (
    <section className="pane pane--terminal">
      <div className="terminal-frame">
        <div className="terminal-host" ref={hostRef} />
        {props.status === "ready" ? null : (
          <p className="pane-placeholder">{PLACEHOLDER[props.status]}</p>
        )}
      </div>
      <div className="player">
        <button
          type="button"
          className="player-button"
          onClick={togglePlay}
          disabled={props.follow || props.status !== "ready" || total === 0}
          title={props.follow ? "Playback is disabled while following live output" : "Space"}
        >
          {playing ? "Pause" : atEnd ? "Replay" : "Play"}
        </button>
        <input
          className="player-scrubber"
          type="range"
          min={0}
          max={total > 0 ? total : 1}
          step={0.01}
          value={elapsed}
          disabled={props.status !== "ready" || total === 0}
          aria-label="Playback position"
          onChange={(event) => {
            if (props.follow) props.onFollowChange(false);
            seek(Number(event.target.value));
          }}
        />
        <span className="player-time">
          {formatSeconds(elapsed)}
          <span className="player-time-sep">/</span>
          {formatSeconds(total)}
        </span>
        <div className="player-speeds">
          {SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              className={`chip${option === speed ? " chip--on" : ""}`}
              onClick={() => {
                setSpeed(option);
              }}
            >
              {option}×
            </button>
          ))}
        </div>
        {props.live ? (
          <label className="player-follow">
            <input
              type="checkbox"
              checked={props.follow}
              onChange={(event) => {
                props.onFollowChange(event.target.checked);
              }}
            />
            follow
          </label>
        ) : null}
      </div>
    </section>
  );
}

const PLACEHOLDER: Readonly<Record<CastStatus, string>> = {
  loading: "Loading terminal recording…",
  ready: "",
  missing: "This session has no terminal recording.",
  error: "The terminal recording could not be read.",
};

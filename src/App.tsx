import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, LoaderCircle, PenLine, RotateCcw, Scissors, X } from "lucide-react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { CandidateFragment, Fragment, GameState, Punctuation } from "../shared/types";
import { glyphLength } from "../shared/game";
import { ApiError, clearSession, createSession, restoreSession, submitCut, submitTurn } from "./api";
import { Turnstile } from "./Turnstile";

gsap.registerPlugin(ScrollTrigger);

const RESULT_KEY = "yuzi:residuals:v1";
const punctuationOptions: Array<{ value: Punctuation; label: string; title: string }> = [
  { value: "。", label: "。", title: "将句子尝试固定为事实" },
  { value: "？", label: "？", title: "提出疑问，让世界暴露另一种可能" },
  { value: "“”", label: "“ ”", title: "让句子成为角色说的话" },
];

export function App() {
  const [game, setGame] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [punctuation, setPunctuation] = useState<Punctuation>("。");
  const [cuts, setCuts] = useState<string[]>([]);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [challengeVersion, setChallengeVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const manuscriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void restoreSession().then(setGame).catch((cause) => {
      if (!(cause instanceof ApiError && [401, 404, 410].includes(cause.status))) setError(friendly(cause));
    }).finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    if (!game?.result) return;
    try {
      const existing = JSON.parse(localStorage.getItem(RESULT_KEY) ?? "[]") as GameState[];
      localStorage.setItem(RESULT_KEY, JSON.stringify([game, ...existing.filter((item) => item.id !== game.id)].slice(0, 5)));
    } catch {}
  }, [game]);

  useLayoutEffect(() => {
    if (!game || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.fromTo(".manuscript-entry:last-child", { y: 34, opacity: 0, scale: 0.97 }, { y: 0, opacity: 1, scale: 1, duration: 0.8, ease: "power3.out" });
      gsap.fromTo(".fragment-button", { y: 12, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.035, duration: 0.45, ease: "power2.out" });
      if (game.result) {
        gsap.fromTo("[data-result-word]", { opacity: 0.1 }, {
          opacity: 1,
          stagger: 0.08,
          scrollTrigger: { trigger: ".result-copy", start: "top 86%", end: "bottom 56%", scrub: 0.6 },
        });
      }
    }, manuscriptRef);
    return () => context.revert();
  }, [game]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!game || busy || event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index <= 8) {
        if (game.phase === "compose" && game.hand[index]) toggleSelected(game.hand[index].id);
        if (game.phase === "cut" && game.candidates[index]) toggleCut(game.candidates[index]);
      }
      if (event.key === "Enter" && game.phase === "compose" && selected.length >= 2) void writeTurn();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  const selectedFragments = useMemo(() => selected.map((id) => game?.hand.find((item) => item.id === id)).filter(Boolean) as Fragment[], [game, selected]);
  const cutLength = useMemo(() => cuts.reduce((sum, id) => sum + glyphLength(game?.candidates.find((item) => item.id === id)?.text ?? ""), 0), [cuts, game]);

  const start = useCallback(async () => {
    if (!turnstileToken) return;
    const token = turnstileToken;
    setTurnstileToken("");
    setBusy(true); setError(null);
    try {
      const result = await createSession(token);
      setGame(result.game); setSelected([]); setCuts([]);
    } catch (cause) {
      setChallengeVersion((current) => current + 1);
      setError(friendly(cause));
    }
    finally { setBusy(false); }
  }, [turnstileToken]);

  const handleChallengeToken = useCallback((token: string) => {
    setTurnstileToken(token);
    setError(null);
  }, []);

  const handleChallengeInvalid = useCallback(() => {
    setTurnstileToken("");
    setError("安全验证暂时不可用，请重试。");
  }, []);

  const writeTurn = async () => {
    if (!game || selected.length < 2) return;
    setBusy(true); setError(null);
    try {
      const next = await submitTurn({ version: game.version, fragmentIds: selected, punctuation });
      setGame(next); setSelected([]); setCuts([]);
      requestAnimationFrame(() => manuscriptRef.current?.scrollTo({ top: manuscriptRef.current.scrollHeight, behavior: "smooth" }));
    } catch (cause) { setError(friendly(cause)); }
    finally { setBusy(false); }
  };

  const makeCut = async () => {
    if (!game || cuts.length === 0) return;
    setBusy(true); setError(null);
    try {
      const next = await submitCut({ version: game.version, candidateIds: cuts });
      setGame(next); setCuts([]);
    } catch (cause) { setError(friendly(cause)); }
    finally { setBusy(false); }
  };

  const reset = () => {
    clearSession(); setGame(null); setSelected([]); setCuts([]); setTurnstileToken(""); setError(null);
  };

  const toggleSelected = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 5 ? [...current, id] : current);
  const toggleCut = (candidate: CandidateFragment) => setCuts((current) => {
    if (current.includes(candidate.id)) return current.filter((item) => item !== candidate.id);
    const nextLength = cutLength + glyphLength(candidate.text);
    return current.length < 2 && game && nextLength <= game.cutBudget ? [...current, candidate.id] : current;
  });
  const move = (id: string, direction: -1 | 1) => setSelected((current) => {
    const index = current.indexOf(id); const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next;
  });

  if (restoring) return <LoadingScreen />;
  if (!game) return <Opening challengeVersion={challengeVersion} token={turnstileToken} busy={busy} error={error} onToken={handleChallengeToken} onError={handleChallengeInvalid} onStart={start} />;

  return (
    <main className="game-shell" ref={manuscriptRef}>
      <header className="game-nav">
        <a href="/lab/" target="_top"><ArrowLeft size={16} /> zxlab / Lab</a>
        <div><span className="live-dot" /> 第 {Math.min(game.turn + 1, game.maxTurns)} / {game.maxTurns} 轮</div>
        <button type="button" className="icon-button" onClick={reset} title="重新开始" aria-label="重新开始"><RotateCcw size={17} /></button>
      </header>

      <section className="game-title-band">
        <h1>余<span className="title-inline-image" aria-hidden="true" />字</h1>
        <p>{game.goal}</p>
      </section>

      <section className="game-grid">
        <article className="manuscript-panel" aria-label="正在消失的手稿">
          <div className="panel-heading"><BookOpen size={17} /><span>未寄出的信</span><span>{game.manuscript.length} 段</span></div>
          <div className="manuscript-stack">
            {game.manuscript.map((paragraph, index) => (
              <p className="manuscript-entry" key={paragraph.id} style={{ zIndex: index + 1 }}>
                {paragraph.text.split(/(□+)/).map((part, partIndex) => part.startsWith("□") ? <mark key={partIndex}>{part}</mark> : part)}
              </p>
            ))}
          </div>
          {game.forbidden.length > 0 && <div className="forbidden-marquee"><div>{[...game.forbidden, ...game.forbidden].map((text, index) => <span key={`${text}-${index}`}>{text} 已离开手稿</span>)}</div></div>}
        </article>

        <aside className="objective-panel">
          <div className="panel-heading"><span>事实仍在变化</span></div>
          <div className="fact-accordion">
            <Fact label="地点" active={game.world.locationKnown} copy={game.world.locationKnown ? "邮局位置明确" : "位置仍不确定"} />
            <Fact label="信件" active={game.world.hasLetter} copy={game.world.hasLetter ? "她已经拿到信" : "信仍未到手"} />
            <Fact label="阅读" active={game.world.readLetter} copy={game.world.readLetter ? "文字已经读过" : "信仍未拆读"} />
            <Fact label="理解" active={game.world.understoodLetter} copy={game.world.understoodLetter ? "她理解了内容" : "意义尚未抵达"} />
          </div>
        </aside>

        <aside className="action-panel">
          {game.result ? <Result game={game} onReset={reset} /> : game.phase === "compose" ? (
            <ComposePanel game={game} selected={selected} selectedFragments={selectedFragments} punctuation={punctuation} busy={busy} error={error} onToggle={toggleSelected} onMove={move} onPunctuation={setPunctuation} onSubmit={writeTurn} />
          ) : (
            <CutPanel game={game} cuts={cuts} cutLength={cutLength} busy={busy} error={error} onToggle={toggleCut} onSubmit={makeCut} />
          )}
        </aside>
      </section>
      <footer className="game-footer"><span>文字不能复制，只能移动。</span><span>短会话在三十分钟后消失</span></footer>
    </main>
  );
}

function Opening({ challengeVersion, token, busy, error, onToken, onError, onStart }: { challengeVersion: number; token: string; busy: boolean; error: string | null; onToken: (token: string) => void; onError: () => void; onStart: () => void }) {
  return <main className="opening-shell">
    <nav className="opening-nav"><a href="/lab/" target="_top"><ArrowLeft size={16} /> zxlab / Lab</a><span>生成式文字构筑</span></nav>
    <section className="opening-scene">
      <div className="opening-copy">
        <h1>余<span className="title-inline-image" aria-hidden="true" />字</h1>
        <p className="opening-premise">从已经发生的故事里剪下意义，把它带到下一句话。</p>
        <div className="opening-goal"><span>五轮目标</span><strong>天亮前，让她读懂那封未寄出的信。</strong></div>
        <Turnstile key={challengeVersion} onToken={onToken} onError={onError} />
        <button className="primary-command" type="button" disabled={!token || busy} onClick={onStart}>{busy ? <LoaderCircle className="spin" /> : <PenLine />} 开始落笔</button>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
      <figure className="opening-image"><img src="/lab/yuzi/game/assets/rain-station.webp" alt="黎明前被云层包围的山谷" /><figcaption>天亮以后，故事会合上。</figcaption></figure>
    </section>
    <div className="opening-next"><ArrowDown size={18} /><span>手稿会记住每一个缺口</span></div>
  </main>;
}

function ComposePanel(props: { game: GameState; selected: string[]; selectedFragments: Fragment[]; punctuation: Punctuation; busy: boolean; error: string | null; onToggle: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void; onPunctuation: (value: Punctuation) => void; onSubmit: () => void }) {
  const sentence = props.selectedFragments.map((item) => item.text).join("");
  return <div className="compose-workspace">
    <div className="panel-heading"><PenLine size={17} /><span>构造下一句话</span></div>
    <div className="sentence-line" aria-live="polite">{sentence || <span>选择并排序意群</span>}{sentence && (props.punctuation === "“”" ? "”" : props.punctuation)}</div>
    <div className="selected-strip">
      {props.selectedFragments.map((fragment, index) => <div className="selected-fragment" key={fragment.id}>
        <button onClick={() => props.onMove(fragment.id, -1)} disabled={index === 0} title="向左移动" aria-label={`${fragment.text} 向左移动`}><ArrowLeft /></button>
        <span>{fragment.text}</span>
        <button onClick={() => props.onMove(fragment.id, 1)} disabled={index === props.selectedFragments.length - 1} title="向右移动" aria-label={`${fragment.text} 向右移动`}><ArrowRight /></button>
        <button onClick={() => props.onToggle(fragment.id)} title="移除" aria-label={`移除 ${fragment.text}`}><X /></button>
      </div>)}
    </div>
    <div className="fragment-pool" aria-label="可用意群">{props.game.hand.map((fragment, index) => <button className="fragment-button" type="button" aria-pressed={props.selected.includes(fragment.id)} onClick={() => props.onToggle(fragment.id)} key={fragment.id}><small>{index + 1}</small>{fragment.text}</button>)}</div>
    <div className="punctuation-control">{punctuationOptions.map((option) => <button type="button" title={option.title} aria-pressed={props.punctuation === option.value} onClick={() => props.onPunctuation(option.value)} key={option.value}>{option.label}</button>)}</div>
    <button className="primary-command" type="button" disabled={props.selected.length < 2 || props.busy} onClick={props.onSubmit}>{props.busy ? <LoaderCircle className="spin" /> : <PenLine />} 写入手稿</button>
    {props.error && <p className="error-message" role="alert">{props.error}</p>}
  </div>;
}

function CutPanel(props: { game: GameState; cuts: string[]; cutLength: number; busy: boolean; error: string | null; onToggle: (candidate: CandidateFragment) => void; onSubmit: () => void }) {
  return <div className="cut-workspace">
    <div className="panel-heading"><Scissors size={17} /><span>从全篇剪下意义</span></div>
    <p className="cut-warning">同名意群会从所有段落消失，只留下一个可移动的字块。</p>
    <div className="cut-budget"><span>可剪 {props.game.cutBudget} 字</span><strong>{props.cutLength} / {props.game.cutBudget}</strong></div>
    <div className="candidate-pool">{props.game.candidates.map((candidate, index) => <button className="fragment-button candidate-button" type="button" aria-pressed={props.cuts.includes(candidate.id)} onClick={() => props.onToggle(candidate)} key={candidate.id}><small>{index + 1}</small><span>{candidate.text}</span><em>{roleLabel(candidate.role)}</em></button>)}</div>
    <button className="primary-command destructive-command" type="button" disabled={props.cuts.length === 0 || props.busy} onClick={props.onSubmit}>{props.busy ? <LoaderCircle className="spin" /> : <Scissors />} 剪下并继续</button>
    {props.error && <p className="error-message" role="alert">{props.error}</p>}
  </div>;
}

function Fact({ label, active, copy }: { label: string; active: boolean; copy: string }) {
  return <details open={active} className={active ? "is-active" : ""}><summary><span>{label}</span><i /></summary><p>{copy}</p></details>;
}

function Result({ game, onReset }: { game: GameState; onReset: () => void }) {
  const words = (game.result?.summary ?? "").split("");
  return <div className="result-copy">
    <span>{game.result?.outcome === "success" ? "手稿成立" : "手稿残缺"}</span>
    <h2>{game.result?.title}</h2>
    <p>{words.map((word, index) => <span data-result-word key={index}>{word}</span>)}</p>
    {game.result?.finalSentence && <blockquote>{game.result.finalSentence}</blockquote>}
    <button className="primary-command" type="button" onClick={onReset}><RotateCcw /> 再写一份</button>
  </div>;
}

function LoadingScreen() { return <main className="loading-screen"><LoaderCircle className="spin" /><p>正在找回未合上的手稿</p></main>; }
function friendly(error: unknown) { return error instanceof Error ? error.message : "手稿暂时没有回应。"; }
function roleLabel(role: CandidateFragment["role"]) { return ({ subject: "人物", time: "时间", action: "动作", object: "对象", place: "地点", memory: "记忆", connector: "连接" } as const)[role]; }

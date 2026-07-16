import { useEffect, useRef, useState } from 'react';
import { Route } from '../../App';
import ModelLayout from '../../components/ModelLayout';
import ServiceDistFields from '../../components/ServiceDistFields';
import { useServiceDist } from '../../hooks/useServiceDist';
import { generateServiceTime, ServiceDist, ServiceDistParams } from './SimEngine';
import { panel, input as inputStyleBase, label as labelStyleBase, button, press, COLORS } from '../../theme';

interface Props { navigate: (r: Route) => void; }

// ---------- Random helpers ----------
function expRandom(rate: number): number {
  return -Math.log(1 - Math.random()) / rate;
}

// ---------- Simulation entity types ----------
type CustState = 'queue' | 'toCounter' | 'service' | 'leaving';

interface Cust {
  id: number;
  x: number; y: number;
  targetX: number; targetY: number;
  state: CustState;
  counterIdx: number;
  svcDuration: number;
  serviceEnd: number;
  arrivalTime: number;
  serviceStart: number;
  priority: 1 | 2; // 1 = higher priority (jumps ahead in queue), 2 = lower priority
}

interface Counter {
  x: number; y: number;
  busy: boolean;
  custId: number | null;
  busyUntil: number;
}

const CANVAS_W = 900;
const CANVAS_H = 420;
const QUEUE_Y = 300;
const QUEUE_START_X = 70;
const QUEUE_SPACING = 34;
const ENTRY_X = 20, ENTRY_Y = 300;
const EXIT_X = 870, EXIT_Y = 300;
const WALK_SPEED = 130; // px/sec

function counterPositions(n: number) {
  const positions: { x: number; y: number }[] = [];
  const totalW = Math.min(n, 8) * 90;
  const startX = CANVAS_W / 2 - totalW / 2 + 45;
  for (let i = 0; i < n; i++) {
    positions.push({ x: startX + i * 90, y: 90 });
  }
  return positions;
}

export default function LiveSimPage({ navigate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const lastMetricsTsRef = useRef<number>(0);

  // Live-editable params (applied on "Apply & Restart")
  const [numCounters, setNumCounters] = useState('2');
  const [arrivalRate, setArrivalRate] = useState('0.6667');
  const [serviceRate, setServiceRate] = useState('0.4');
  const svcState = useServiceDist('exponential');
  const [speed, setSpeed] = useState(1);

  // Advanced: priority-based queuing. When enabled, each arriving customer is
  // randomly assigned Priority 1 (higher) with probability `priorityPercent`%,
  // otherwise Priority 2 (lower). Priority 1 customers skip ahead of any
  // Priority 2 customers already waiting in queue (non-preemptive — someone
  // already in service is never interrupted).
  const [advancedMode, setAdvancedMode] = useState(false);
  const [priorityPercent, setPriorityPercent] = useState('30');

  const [running, setRunning] = useState(true);
  const [metrics, setMetrics] = useState({
    simTime: 0, arrived: 0, served: 0, inQueue: 0, inService: 0,
    avgWait: 0, avgResponse: 0, utilization: 0, throughput: 0,
    avgServiceTime: 0,
    avgWaitP1: 0, avgWaitP2: 0,
  });

  // Mutable simulation state, lives across frames without re-render
  const sim = useRef({
    simTime: 0,
    nextArrival: 0,
    nextId: 1,
    queue: [] as Cust[],
    active: [] as Cust[], // toCounter / service / leaving
    counters: [] as Counter[],
    arrived: 0,
    served: 0,
    totalWait: 0,
    totalResponse: 0,
    totalServiceBusy: 0,
    serviceStarted: 0,
    totalWaitP1: 0,
    servedP1: 0,
    totalWaitP2: 0,
    servedP2: 0,
    params: {
      counters: 2, lambda: 0.6667, mu: 0.4, dist: 'exponential' as ServiceDist, distParams: undefined as ServiceDistParams | undefined,
      advanced: false, priorityPct: 30,
    },
  });

  function resetSim() {
    const S = Math.max(1, Math.min(8, parseInt(numCounters) || 1));
    const lambda = Math.max(0.01, parseFloat(arrivalRate) || 1);
    const mu = Math.max(0.01, parseFloat(serviceRate) || 1);
    const priorityPct = Math.max(0, Math.min(100, parseFloat(priorityPercent) || 0));
    const positions = counterPositions(S);
    sim.current = {
      simTime: 0,
      nextArrival: expRandom(lambda),
      nextId: 1,
      queue: [],
      active: [],
      counters: positions.map(p => ({ x: p.x, y: p.y, busy: false, custId: null, busyUntil: Infinity })),
      arrived: 0,
      served: 0,
      totalWait: 0,
      totalResponse: 0,
      totalServiceBusy: 0,
      serviceStarted: 0,
      totalWaitP1: 0,
      servedP1: 0,
      totalWaitP2: 0,
      servedP2: 0,
      params: { counters: S, lambda, mu, dist: svcState.dist, distParams: svcState.getParams(1 / mu), advanced: advancedMode, priorityPct },
    };
    lastTsRef.current = null;
    setMetrics({ simTime: 0, arrived: 0, served: 0, inQueue: 0, inService: 0, avgWait: 0, avgResponse: 0, utilization: 0, throughput: 0, avgServiceTime: 0, avgWaitP1: 0, avgWaitP2: 0 });
  }

  useEffect(() => {
    resetSim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyAndRestart() {
    resetSim();
    setRunning(true);
  }

  // ---------- Main animation loop ----------
  useEffect(() => {
    function frame(ts: number) {
      const canvas = canvasRef.current;
      if (!canvas) { rafRef.current = requestAnimationFrame(frame); return; }
      const ctx = canvas.getContext('2d');
      if (!ctx) { rafRef.current = requestAnimationFrame(frame); return; }

      if (lastTsRef.current === null) lastTsRef.current = ts;
      const rawDt = Math.min(0.05, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;
      const s = sim.current;

      if (running) {
        const dt = rawDt * speed;
        s.simTime += dt;

        // Spawn arrivals
        while (s.simTime >= s.nextArrival) {
          const priority: 1 | 2 = s.params.advanced
            ? (Math.random() * 100 < s.params.priorityPct ? 1 : 2)
            : 1;
          const cust: Cust = {
            id: s.nextId++, x: ENTRY_X, y: ENTRY_Y,
            targetX: QUEUE_START_X + s.queue.length * QUEUE_SPACING, targetY: QUEUE_Y,
            state: 'queue',
            counterIdx: -1, svcDuration: 0, serviceEnd: 0, arrivalTime: s.simTime, serviceStart: 0,
            priority,
          };
          if (s.params.advanced) {
            // Priority queue-jump: a Priority 1 customer walks in ahead of
            // every Priority 2 customer already waiting, but behind any
            // Priority 1 customers who arrived earlier (FIFO within a tier).
            // Non-preemptive: nobody already being served is interrupted.
            let insertIdx = s.queue.length;
            for (let i = 0; i < s.queue.length; i++) {
              if (s.queue[i].priority > priority) { insertIdx = i; break; }
            }
            s.queue.splice(insertIdx, 0, cust);
          } else {
            s.queue.push(cust);
          }
          s.arrived++;
          s.nextArrival += expRandom(s.params.lambda);
        }

        // Free counters whose service has actually completed
        for (const c of s.counters) {
          if (c.busy && s.simTime >= c.busyUntil) {
            const cust = s.active.find(a => a.id === c.custId && a.state === 'service');
            if (cust) {
              cust.state = 'leaving';
              cust.targetX = EXIT_X; cust.targetY = EXIT_Y;
              s.served++;
              s.totalResponse += (cust.serviceEnd - cust.arrivalTime);
            }
            c.busy = false; c.custId = null; c.busyUntil = Infinity;
          }
        }

        // Assign free counters to head of queue.
        // Note: busyUntil stays Infinity while the customer is still walking over —
        // it's only set to a real time once they actually arrive (see transition below).
        // Otherwise a short service time + long walk could free the counter before
        // the customer even gets there, letting a second customer be assigned to it.
        for (const c of s.counters) {
          if (!c.busy && s.queue.length > 0) {
            const cust = s.queue.shift()!;
            const svcTime = generateServiceTime(s.params.dist, s.params.mu, s.params.distParams);
            cust.state = 'toCounter';
            cust.counterIdx = s.counters.indexOf(c);
            cust.targetX = c.x; cust.targetY = c.y;
            cust.svcDuration = svcTime;
            c.busy = true; c.custId = cust.id; c.busyUntil = Infinity;
            s.active.push(cust);
          }
        }

        // Re-target queue positions (compact toward front)
        s.queue.forEach((c, i) => {
          c.targetX = QUEUE_START_X + i * QUEUE_SPACING;
          c.targetY = QUEUE_Y;
        });

        // Move everyone toward target
        const moveStep = WALK_SPEED * dt;
        const moveAll = (list: Cust[]) => {
          for (const c of list) {
            const dx = c.targetX - c.x, dy = c.targetY - c.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 1) {
              const step = Math.min(dist, moveStep);
              c.x += (dx / dist) * step;
              c.y += (dy / dist) * step;
            }
          }
        };
        moveAll(s.queue);
        moveAll(s.active);

        // Handle transition from toCounter -> service once actually arrived at the counter
        for (const c of s.active) {
          if (c.state === 'toCounter') {
            const dist = Math.hypot(c.targetX - c.x, c.targetY - c.y);
            if (dist < 1.5) {
              c.state = 'service';
              c.serviceStart = s.simTime;
              c.serviceEnd = s.simTime + c.svcDuration;
              const counter = s.counters[c.counterIdx];
              counter.busyUntil = c.serviceEnd;
              const w = c.serviceStart - c.arrivalTime;
              s.totalWait += w;
              s.totalServiceBusy += c.svcDuration;
              s.serviceStarted++;
              if (c.priority === 1) { s.totalWaitP1 += w; s.servedP1++; }
              else { s.totalWaitP2 += w; s.servedP2++; }
            }
          }
        }

        // Remove customers that reached exit
        s.active = s.active.filter(c => {
          if (c.state === 'leaving') {
            const dist = Math.hypot(c.targetX - c.x, c.targetY - c.y);
            return dist > 2;
          }
          return true;
        });
      }

      draw(ctx, s);

      // Throttle metrics state update (~5x/sec) to avoid excess re-renders
      if (!lastMetricsTsRef.current || ts - lastMetricsTsRef.current > 200) {
        lastMetricsTsRef.current = ts;
        const busyCounters = s.counters.filter(c => c.busy).length;
        setMetrics({
          simTime: s.simTime,
          arrived: s.arrived,
          served: s.served,
          inQueue: s.queue.length,
          inService: s.active.filter(a => a.state === 'service' || a.state === 'toCounter').length,
          avgWait: s.served > 0 ? s.totalWait / Math.max(1, s.served) : 0,
          avgResponse: s.served > 0 ? s.totalResponse / Math.max(1, s.served) : 0,
          utilization: s.counters.length > 0 ? busyCounters / s.counters.length : 0,
          throughput: s.simTime > 0 ? s.served / s.simTime : 0,
          avgServiceTime: s.serviceStarted > 0 ? s.totalServiceBusy / s.serviceStarted : 0,
          avgWaitP1: s.servedP1 > 0 ? s.totalWaitP1 / s.servedP1 : 0,
          avgWaitP2: s.servedP2 > 0 ? s.totalWaitP2 / s.servedP2 : 0,
        });
      }

      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, speed]);

  function draw(ctx: CanvasRenderingContext2D, s: typeof sim.current) {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Background — plain white
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Floor line
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, QUEUE_Y + 26); ctx.lineTo(CANVAS_W, QUEUE_Y + 26); ctx.stroke();

    // Entry / exit labels
    ctx.fillStyle = '#000000'; ctx.font = 'bold 12px Arial';
    ctx.fillText('ENTRY', ENTRY_X - 12, ENTRY_Y + 40);
    ctx.fillText('EXIT', EXIT_X - 8, EXIT_Y + 40);

    // Counters (fixed)
    s.counters.forEach((c, i) => {
      ctx.fillStyle = c.busy ? '#ffd400' : '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;
      ctx.fillRect(c.x - 30, c.y - 28, 60, 56);
      ctx.strokeRect(c.x - 30, c.y - 28, 60, 56);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 12px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(`Counter ${i + 1}`, c.x, c.y - 36);
      ctx.font = 'bold 12px Arial';
      ctx.fillText(c.busy ? 'Busy' : 'Free', c.x, c.y + 5);
      ctx.textAlign = 'left';
    });

    // Queue guide line
    if (s.queue.length > 0) {
      ctx.strokeStyle = '#000000';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(QUEUE_START_X - 20, QUEUE_Y);
      ctx.lineTo(QUEUE_START_X + Math.max(0, s.queue.length - 1) * QUEUE_SPACING + 20, QUEUE_Y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw customer sprites
    const allCusts = [...s.queue, ...s.active];
    for (const c of allCusts) {
      drawCustomer(ctx, c.x, c.y, c.id, s.params.advanced ? c.priority : undefined);
    }

    // Overflow indicator if queue very long
    if (s.queue.length > 20) {
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 13px Arial';
      ctx.fillText(`+${s.queue.length - 20} more waiting`, QUEUE_START_X, QUEUE_Y - 30);
    }
  }

  function drawCustomer(ctx: CanvasRenderingContext2D, x: number, y: number, id: number, priority?: 1 | 2) {
    ctx.fillStyle = priority === 1 ? '#ff3b30' : '#ff3ea5';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = priority === 1 ? 3 : 2;
    ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`C${id}`, x, y + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (priority === 1) {
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 9px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('P1', x, y - 18);
      ctx.textAlign = 'left';
    }
  }

  const statCards = [
    { label: 'Sim Time', value: metrics.simTime.toFixed(1) + 's' },
    { label: 'Arrived', value: String(metrics.arrived) },
    { label: 'Served', value: String(metrics.served) },
    { label: 'In Queue', value: String(metrics.inQueue) },
    { label: 'In Service', value: String(metrics.inService) },
    { label: 'Avg Wait', value: metrics.avgWait.toFixed(2) },
    { label: 'Avg Service Time', value: metrics.avgServiceTime.toFixed(2) },
    { label: 'Avg Response', value: metrics.avgResponse.toFixed(2) },
    { label: 'Utilization', value: `${(metrics.utilization * 100).toFixed(0)}%` },
    { label: 'Throughput', value: metrics.throughput.toFixed(2) + '/s' },
    ...(advancedMode ? [
      { label: 'Avg Wait (P1)', value: metrics.avgWaitP1.toFixed(2) },
      { label: 'Avg Wait (P2)', value: metrics.avgWaitP2.toFixed(2) },
    ] : []),
  ];

  return (
    <ModelLayout title="Live Simulator" subtitle="Watch customers arrive, queue, and get served in real time" badge="Animated Simulation" navigate={navigate} back="simulation" accentColor={COLORS.orange}>
      {/* Controls */}
      <div style={{ ...panel, marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
          <div>
            <label style={labelStyleBase}>Counters (Servers)</label>
            <input style={inputStyleBase} type="number" min={1} max={8} value={numCounters} onChange={e => setNumCounters(e.target.value)} />
          </div>
          <div>
            <label style={labelStyleBase}>Arrival Rate (λ)</label>
            <input style={inputStyleBase} type="number" step="0.01" min={0.01} value={arrivalRate} onChange={e => setArrivalRate(e.target.value)} />
          </div>
          <div>
            <label style={labelStyleBase}>Service Rate (μ)</label>
            <input style={inputStyleBase} type="number" step="0.01" min={0.01} value={serviceRate} onChange={e => setServiceRate(e.target.value)} />
          </div>
          <ServiceDistFields state={svcState} />
          <div>
            <label style={labelStyleBase}>Speed: {speed}×</label>
            <input style={{ width: '100%' }} type="range" min={0.25} max={5} step={0.25} value={speed} onChange={e => setSpeed(parseFloat(e.target.value))} />
          </div>
        </div>

        {/* Advanced: priority-based queuing */}
        <div style={{ marginTop: 20, paddingTop: 20, borderTop: '2px solid #000' }}>
          <button
            onClick={() => setAdvancedMode(a => !a)}
            style={button(advancedMode ? COLORS.red : COLORS.surface)}
            onMouseDown={e => press(e, true)} onMouseUp={e => press(e, false)} onMouseLeave={e => press(e, false)}
          >
            {advancedMode ? '☑' : '☐'} Advanced: Priority Queuing
          </button>

          {advancedMode && (
            <div style={{ marginTop: 16, maxWidth: 260 }}>
              <label style={labelStyleBase}>Priority 1 Population (%)</label>
              <input
                style={inputStyleBase}
                type="number" min={0} max={100} step="1"
                value={priorityPercent}
                onChange={e => setPriorityPercent(e.target.value)}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: COLORS.sub, fontWeight: 600 }}>
                This % of arriving customers get Priority 1 (higher) and skip ahead of any
                Priority 2 (lower) customers already waiting. The rest get Priority 2. Nobody
                already being served is ever interrupted.
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 20, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={applyAndRestart} style={button(COLORS.orange)}
            onMouseDown={e => press(e, true)} onMouseUp={e => press(e, false)} onMouseLeave={e => press(e, false)}
          >🔄 Apply &amp; Restart</button>
          <button onClick={() => setRunning(r => !r)} style={button(COLORS.surface)}
            onMouseDown={e => press(e, true)} onMouseUp={e => press(e, false)} onMouseLeave={e => press(e, false)}
          >{running ? '⏸ Pause' : '▶ Resume'}</button>
        </div>
      </div>

      {/* Live metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 12, marginBottom: 20 }}>
        {statCards.map(m => (
          <div key={m.label} style={{ background: COLORS.orange, border: '2px solid #000', padding: '14px 10px', textAlign: 'center' }}>
            <div style={{ color: COLORS.ink, fontSize: 18, fontWeight: 900 }}>{m.value}</div>
            <div style={{ color: COLORS.ink, fontSize: 11, marginTop: 4, fontWeight: 700, textTransform: 'uppercase' }}>{m.label}</div>
          </div>
        ))}
      </div>

      {/* Canvas */}
      <div style={{ ...panel, padding: 16, overflowX: 'auto' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: '100%', maxWidth: CANVAS_W, height: 'auto', display: 'block', margin: '0 auto', border: '3px solid #000' }}
        />
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap', marginTop: 16, fontSize: 12, color: COLORS.sub, fontWeight: 600 }}>
        <span>Circle labeled C1, C2, ... = a customer</span>
        <span>Box labeled Counter = a service point (Free / Busy)</span>
        {advancedMode && <span>🔴 Red / "P1" = Priority 1 (skips ahead) &nbsp;·&nbsp; 🩷 Pink = Priority 2</span>}
      </div>
    </ModelLayout>
  );
}

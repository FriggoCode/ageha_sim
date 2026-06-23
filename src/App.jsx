import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONSTANTES FÍSICAS (del esquema SQL / anteproyecto) ──────────────────────
const TEMP_AMBIENTE = 25.0;
const TEMP_BASE_IDLE = 35.0;
const TEMP_MIN_SAT = 36.0;
const TEMP_MAX_SAT = 80.0;
const TEMP_MIN_OVERSAT = 81.0;
const TEMP_MAX_OVERSAT = 100.0;
const VOLTAJE_UMBRAL_ALERTA = 4.20;
const CONSTANTE_K = 0.1;
const COEFICIENTE_ALPHA = 0.05;
const RESISTENCIA_R = 10000.0;
const CAPACITANCIA_C = 0.0001;
const INFLUENCIA_RADIO = 2;

// ─── FÓRMULAS DE CÁLCULO ─────────────────────────────────────────────────────
// T_propia = T_idle + sat * (T_max_sat - T_idle)  cuando sat < 1
// T_propia = T_min_oversat + oversat * (T_max_oversat - T_min_oversat) cuando oversat > 0
// T_vecino += delta_T * factor_distancia  (1 - dist/radio)
// V_out = V_in * exp(-t / RC)   voltaje filtrado RC
// V_in = 3.3 + sat * 0.9 + oversat * 1.5

function calcTemperatura(sat, oversat) {
  if (oversat > 0) {
    return TEMP_MIN_OVERSAT + oversat * (TEMP_MAX_OVERSAT - TEMP_MIN_OVERSAT);
  }
  if (sat <= 0) return TEMP_BASE_IDLE;
  return TEMP_MIN_SAT + sat * (TEMP_MAX_SAT - TEMP_MIN_SAT);
}

function calcVoltajeEntrada(sat, oversat) {
  return 3.3 + sat * 0.9 + oversat * 1.5;
}

function calcVoltajeSalida(vin, sat, oversat) {
  const t = (sat + oversat) * 0.5;
  return vin * Math.exp(-t / (RESISTENCIA_R * CAPACITANCIA_C + 0.001));
}

function distancia3D(a, b) {
  return Math.sqrt(
    Math.pow(a.x - b.x, 2) +
    Math.pow(a.y - b.y, 2) +
    Math.pow(a.z - b.z, 2)
  );
}

function calcTemperaturaConVecinos(servidor, servidores) {
  const tempPropia = calcTemperatura(servidor.saturacion, servidor.sobresaturacion);
  let calentamiento = 0;
  for (const otro of servidores) {
    if (otro.id === servidor.id) continue;
    const d = distancia3D(servidor, otro);
    if (d <= INFLUENCIA_RADIO && d > 0) {
      const tempVecino = calcTemperatura(otro.saturacion, otro.sobresaturacion);
      // Solo transferimos calor si el vecino está más caliente
      if (tempVecino <= tempPropia) continue;
      const delta = tempVecino - tempPropia;
      // 75% de transferencia a d≤1 casilla, 30% a d≤2 casillas
      const factor = d <= 1 ? 0.75 : 0.30;
      calentamiento += delta * factor;
    }
  }
  return Math.min(100, tempPropia + calentamiento);
}

// ─── COLOR POR TEMPERATURA ───────────────────────────────────────────────────
function tempToColor(t) {
  if (t <= 35) return { r: 59, g: 130, b: 246 };      // azul frío
  if (t <= 55) {
    const p = (t - 35) / 20;
    return { r: Math.round(59 + p * 196), g: Math.round(130 - p * 50), b: Math.round(246 - p * 246) };
  }
  if (t <= 80) {
    const p = (t - 55) / 25;
    return { r: 255, g: Math.round(80 - p * 80), b: 0 };
  }
  const p = (t - 80) / 20;
  return { r: 255, g: 0, b: Math.round(p * 100) };
}

function colorCSS(t) {
  const c = tempToColor(t);
  return `rgb(${c.r},${c.g},${c.b})`;
}

function colorHex(t) {
  const c = tempToColor(t);
  return "#" + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, "0")).join("");
}

// ─── ESTADO INICIAL ───────────────────────────────────────────────────────────
let nextId = 1;
function makeServidor(nombre, x, y, z) {
  return { id: nextId++, nombre, x, y, z, saturacion: 0, sobresaturacion: 0 };
}

const INITIAL_SERVERS = [
  makeServidor("SRV-Alpha", 1, 0, 1),
  makeServidor("SRV-Beta", 4, 1, 4),
  makeServidor("SRV-Gamma", 7, 0, 7),
];

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────────────────
export default function App() {
  const [servidores, setServidores] = useState(INITIAL_SERVERS);
  const [selected, setSelected] = useState(null);
  const [alertas, setAlertas] = useState([]);
  const [tab, setTab] = useState("dashboard");
  const [editForm, setEditForm] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newSrv, setNewSrv] = useState({ nombre: "", x: 0, y: 0, z: 0 });
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const rotRef = useRef({ yaw: 0.4, pitch: 0.35, dragging: false, lastX: 0, lastY: 0 });

  // ── Calcular temperatura efectiva de cada servidor
  const temps = servidores.map(s => ({
    id: s.id,
    temp: calcTemperaturaConVecinos(s, servidores),
    vin: calcVoltajeEntrada(s.saturacion, s.sobresaturacion),
    vout: 0,
  })).map(t => {
    const srv = servidores.find(s => s.id === t.id);
    return { ...t, vout: calcVoltajeSalida(t.vin, srv.saturacion, srv.sobresaturacion) };
  });

  const getTemp = (id) => temps.find(t => t.id === id)?.temp ?? 35;
  const getVout = (id) => temps.find(t => t.id === id)?.vout ?? 0;

  // ── Detectar alertas
  useEffect(() => {
    const nuevas = [];
    for (const srv of servidores) {
      const vout = getVout(srv.id);
      if (vout > VOLTAJE_UMBRAL_ALERTA || srv.sobresaturacion > 0) {
        const existe = alertas.find(a => a.id === srv.id && !a.acked);
        if (!existe) {
          nuevas.push({
            uid: Date.now() + Math.random(),
            id: srv.id,
            nombre: srv.nombre,
            temp: getTemp(srv.id),
            vout,
            sobresaturacion: srv.sobresaturacion,
            ts: new Date().toLocaleTimeString(),
            acked: false,
            tipo: srv.sobresaturacion > 0 ? "CRITICO" : "TERMICO",
          });
        }
      }
    }
    if (nuevas.length) setAlertas(prev => [...prev, ...nuevas].slice(-50));
  }, [servidores]);

  // ── Canvas 3D isométrico
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || tab !== "dashboard") return;
    const ctx = canvas.getContext("2d");

    function project(x, y, z) {
      const yaw = rotRef.current.yaw;
      const pitch = rotRef.current.pitch;
      const cx = Math.cos(yaw), sx = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const rx = cx * x + sx * z;
      const rz = -sx * x + cx * z;
      const ry = y;
      const screenX = 320 + rx * 28;
      const screenY = 240 - rz * 28 * cp - ry * 28 * sp;
      return { sx: screenX, sy: screenY };
    }

    function drawScene() {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Fondo oscuro
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, W, H);

      // Grilla del piso (plano y=0)
      ctx.strokeStyle = "#1e2a3a";
      ctx.lineWidth = 0.5;
      for (let xi = 0; xi <= 9; xi++) {
        const a = project(xi, 0, 0), b = project(xi, 0, 9);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      for (let zi = 0; zi <= 9; zi++) {
        const a = project(0, 0, zi), b = project(9, 0, zi);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }

      // Bordes del volumen
      ctx.strokeStyle = "#2a4060";
      ctx.lineWidth = 1;
      const corners = [
        [0,0,0],[9,0,0],[9,0,9],[0,0,9],
        [0,2,0],[9,2,0],[9,2,9],[0,2,9],
      ];
      const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
      for (const [a,b] of edges) {
        const pa = project(...corners[a]), pb = project(...corners[b]);
        ctx.beginPath(); ctx.moveTo(pa.sx, pa.sy); ctx.lineTo(pb.sx, pb.sy); ctx.stroke();
      }

      // Ordenar servidores por profundidad para z-sorting
      const sorted = [...servidores].sort((a, b) => {
        const pa = project(a.x, a.y, a.z);
        const pb = project(b.x, b.y, b.z);
        return pb.sy - pa.sy;
      });

      for (const srv of sorted) {
        const t = getTemp(srv.id);
        const col = colorHex(t);
        const p = project(srv.x, srv.y, srv.z);
        const isSel = selected === srv.id;
        const r = isSel ? 20 : 16;

        // Halo de calor
        if (t > 50) {
          const grad = ctx.createRadialGradient(p.sx, p.sy, r, p.sx, p.sy, r + 25);
          const c = tempToColor(t);
          grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0.25)`);
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, r + 25, 0, Math.PI * 2); ctx.fill();
        }

        // Cuerpo del servidor
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = isSel ? 20 : 10;
        ctx.beginPath(); ctx.roundRect(p.sx - r, p.sy - r * 0.6, r * 2, r * 1.2, 4); ctx.fill();
        ctx.shadowBlur = 0;

        // Borde selección
        if (isSel) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.roundRect(p.sx - r - 2, p.sy - r * 0.6 - 2, r * 2 + 4, r * 1.2 + 4, 5); ctx.stroke();
        }

        // Etiqueta
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.fillText(srv.nombre.substring(0, 9), p.sx, p.sy + r * 0.6 + 12);

        // Temperatura
        ctx.fillStyle = col;
        ctx.font = "bold 10px monospace";
        ctx.fillText(`${t.toFixed(1)}°C`, p.sx, p.sy - r * 0.6 - 5);
      }

      // Leyenda temperatura
      const lgx = W - 30, lgy = 40, lgh = 160;
      const lg = ctx.createLinearGradient(0, lgy, 0, lgy + lgh);
      lg.addColorStop(0, "#ff0064");
      lg.addColorStop(0.3, "rgb(255,80,0)");
      lg.addColorStop(0.6, "rgb(255,200,0)");
      lg.addColorStop(1, "rgb(59,130,246)");
      ctx.fillStyle = lg;
      ctx.fillRect(lgx, lgy, 12, lgh);
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 1;
      ctx.strokeRect(lgx, lgy, 12, lgh);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "9px monospace";
      ctx.textAlign = "left";
      ctx.fillText("100°", lgx + 16, lgy + 5);
      ctx.fillText("80°", lgx + 16, lgy + lgh * 0.3 + 4);
      ctx.fillText("55°", lgx + 16, lgy + lgh * 0.6 + 4);
      ctx.fillText("35°", lgx + 16, lgy + lgh + 4);
    }

    function loop() { drawScene(); animRef.current = requestAnimationFrame(loop); }
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [servidores, selected, tab]);

  // ── Interacción canvas: arrastrar para rotar + click para seleccionar
  const handleCanvasMouseDown = (e) => {
    rotRef.current.dragging = true;
    rotRef.current.lastX = e.clientX;
    rotRef.current.lastY = e.clientY;
  };
  const handleCanvasMouseMove = (e) => {
    if (!rotRef.current.dragging) return;
    const dx = e.clientX - rotRef.current.lastX;
    const dy = e.clientY - rotRef.current.lastY;
    rotRef.current.yaw += dx * 0.01;
    rotRef.current.pitch = Math.max(-0.1, Math.min(1.2, rotRef.current.pitch - dy * 0.01));
    rotRef.current.lastX = e.clientX;
    rotRef.current.lastY = e.clientY;
  };
  const handleCanvasMouseUp = (e) => {
    rotRef.current.dragging = false;
  };

  const handleCanvasClick = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const yaw = rotRef.current.yaw;
    const pitch = rotRef.current.pitch;
    for (const srv of servidores) {
      const cx2 = Math.cos(yaw), sx2 = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const rx = cx2 * srv.x + sx2 * srv.z;
      const rz = -sx2 * srv.x + cx2 * srv.z;
      const sx3 = 320 + rx * 28;
      const sy3 = 240 - rz * 28 * cp - srv.y * 28 * sp;
      if (Math.abs(mx - sx3) < 20 && Math.abs(my - sy3) < 16) {
        setSelected(srv.id);
        return;
      }
    }
    setSelected(null);
  };

  // ── Cambiar saturación
  const setSat = (id, val) => {
    setServidores(prev => prev.map(s => s.id === id ? { ...s, saturacion: val, sobresaturacion: val < 1 ? 0 : s.sobresaturacion } : s));
  };
  const setOversat = (id, val) => {
    setServidores(prev => prev.map(s => s.id === id ? { ...s, sobresaturacion: val } : s));
  };

  // ── Eliminar servidor
  const deleteServer = (id) => {
    setServidores(prev => prev.filter(s => s.id !== id));
    if (selected === id) setSelected(null);
  };

  // ── Guardar edición
  const saveEdit = () => {
    if (!editForm) return;
    setServidores(prev => prev.map(s => s.id === editForm.id ? { ...s, ...editForm } : s));
    setEditForm(null);
  };

  // ── Agregar servidor
  const addServer = () => {
    const occupied = servidores.some(s => s.x === newSrv.x && s.y === newSrv.y && s.z === newSrv.z);
    if (occupied) return alert("Posición ocupada por otro servidor.");
    const srv = makeServidor(newSrv.nombre || `SRV-${nextId}`, newSrv.x, newSrv.y, newSrv.z);
    setServidores(prev => [...prev, srv]);
    setShowAddModal(false);
    setNewSrv({ nombre: "", x: 0, y: 0, z: 0 });
  };

  const selSrv = servidores.find(s => s.id === selected);
  const selTemp = selected ? getTemp(selected) : null;
  const selVout = selected ? getVout(selected) : null;
  const activeAlerts = alertas.filter(a => !a.acked);

  const styles = {
    app: { fontFamily: "'JetBrains Mono', 'Fira Code', monospace", background: "#0a0e1a", minHeight: "100vh", color: "#e2e8f0", display: "flex", flexDirection: "column" },
    header: { background: "linear-gradient(90deg, #0f172a 0%, #1e293b 100%)", borderBottom: "1px solid #1e3a5f", padding: "0 24px", display: "flex", alignItems: "center", gap: 24, height: 56 },
    logo: { display: "flex", alignItems: "center", gap: 10, color: "#38bdf8", fontSize: 15, fontWeight: 700, letterSpacing: 1 },
    tabs: { display: "flex", gap: 2, marginLeft: "auto" },
    tab: (active) => ({ padding: "6px 18px", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600, letterSpacing: 0.5, background: active ? "#0ea5e9" : "transparent", color: active ? "#fff" : "#64748b", transition: "all 0.2s" }),
    alertBadge: { background: "#ef4444", color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 10, marginLeft: 4 },
    main: { display: "flex", flex: 1, gap: 0, overflow: "hidden" },
    panel: { width: 300, background: "#0f172a", borderRight: "1px solid #1e2a3a", display: "flex", flexDirection: "column", overflow: "hidden" },
    center: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
    canvas: { background: "#0d1117", cursor: "grab", userSelect: "none" },
    sidebar: { width: 280, background: "#0f172a", borderLeft: "1px solid #1e2a3a", display: "flex", flexDirection: "column", padding: 16, gap: 12, overflowY: "auto" },
    card: { background: "#1e2a3a", borderRadius: 8, padding: 12, border: "1px solid #253545" },
    label: { color: "#64748b", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 },
    srvItem: (isSel) => ({ padding: "10px 14px", cursor: "pointer", borderLeft: "3px solid", borderLeftColor: isSel ? "#0ea5e9" : "transparent", background: isSel ? "#1e2a3a" : "transparent", display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s" }),
    tempBadge: (t) => ({ background: colorCSS(t), color: t > 60 ? "#fff" : "#000", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 }),
    slider: { width: "100%", accentColor: "#0ea5e9", cursor: "pointer" },
    btn: (variant) => ({
      padding: "7px 14px", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: "inherit", fontWeight: 700,
      background: variant === "danger" ? "#7f1d1d" : variant === "success" ? "#064e3b" : variant === "primary" ? "#0ea5e9" : "#1e2a3a",
      color: variant === "danger" ? "#fca5a5" : variant === "success" ? "#6ee7b7" : variant === "primary" ? "#fff" : "#94a3b8",
      letterSpacing: 0.5,
    }),
    input: { background: "#0a0e1a", border: "1px solid #253545", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontFamily: "inherit", fontSize: 12, width: "100%", boxSizing: "border-box" },
    modal: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
    modalBox: { background: "#1e2a3a", border: "1px solid #334155", borderRadius: 12, padding: 28, width: 340, display: "flex", flexDirection: "column", gap: 14 },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  PESTAÑA: INFORMACIÓN
  // ═══════════════════════════════════════════════════════════════════════════
  if (tab === "info") return (
    <div style={styles.app}>
      <div style={styles.header}>
        <div style={styles.logo}>⚡ AGEHA THERMAL SIMULATOR</div>
        <div style={styles.tabs}>
          {["dashboard","alertas","info"].map(t2 => (
            <button key={t2} style={styles.tab(tab===t2)} onClick={()=>setTab(t2)}>
              {t2.toUpperCase()}{t2==="alertas"&&activeAlerts.length>0&&<span style={styles.alertBadge}>{activeAlerts.length}</span>}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"32px 10%", display:"flex", flexDirection:"column", gap:28 }}>
        <h2 style={{ color:"#38bdf8", fontSize:22, margin:0 }}>Fórmulas y Modelos del Sistema</h2>

        {[
          {
            titulo: "1. Temperatura Propia del Servidor",
            formula: "T_servidor(sat, oversat) =\n  sat = 0      →  35.0 °C\n  oversat = 0  →  36 + sat × (80 - 36)    [°C]\n  oversat > 0  →  81 + oversat × (100 - 81) [°C]",
            desc: "La temperatura base sin saturación es 35 °C. Al saturar, crece linealmente de 36 °C a 80 °C. En sobresaturación (sat = 1.0) sube de 81 °C a 100 °C.",
          },
          {
            titulo: "2. Influencia Térmica Vecinal",
            formula: "ΔT = Σ (T_vecino - T_propio) × factor_distancia\n\n  d ≤ 1 casilla  →  factor = 0.75  (75% de transferencia)\n  d ≤ 2 casillas →  factor = 0.30  (30% de transferencia)\n  Solo si T_vecino > T_propio (calor fluye del más caliente)\n  d = distancia euclidiana 3D",
            desc: "Cada servidor vecino más caliente dentro de 2 casillas eleva la temperatura del servidor objetivo. A 1 casilla de distancia se transfiere el 75% de la diferencia de temperatura; a 2 casillas, el 30%.",
          },
          {
            titulo: "3. Temperatura Efectiva Final",
            formula: "T_efectiva = min(100, T_propia + ΔT_vecinos)",
            desc: "La temperatura efectiva combina la propia y la aportada por vecinos, con tope en 100 °C.",
          },
          {
            titulo: "4. Voltaje de Entrada (Carga)",
            formula: "V_in = 3.3 + sat × 0.9 + oversat × 1.5   [V]",
            desc: "El voltaje de entrada modela la carga eléctrica. Sin saturación: 3.3 V. Al 100% saturación: 4.2 V. Sobresaturación adicional puede superar 4.2 V.",
          },
          {
            titulo: "5. Voltaje Filtrado RC (Salida)",
            formula: "V_out = V_in × exp(−t / (R × C))\n\n  t = (sat + oversat) × 0.5   [tiempo normalizado]\n  R = 10 000 Ω\n  C = 0.0001 F\n  RC = 1.0 s",
            desc: "El filtro RC modela el efecto capacitivo del sistema de alimentación. Un voltaje de salida > 4.20 V activa la alerta térmica.",
          },
          {
            titulo: "6. Umbral de Alerta",
            formula: "ALERTA si V_out > 4.20 V  (umbral seguro de operación)\nCRÍTICO si oversat > 0   (sobresaturación activa)",
            desc: "Dos tipos de alerta: térmica cuando el voltaje filtrado supera el umbral operativo, y crítica cuando el servidor entra en régimen de sobresaturación extrema.",
          },
          {
            titulo: "7. Espacio de Simulación",
            formula: "Eje X: [0.00 – 9.00]\nEje Y: [0.00 – 2.00]\nEje Z: [0.00 – 9.00]",
            desc: "Dominio cúbico de 9×2×9 unidades. Las coordenadas son numéricas con precisión de 2 decimales (tipos DOMAIN de PostgreSQL).",
          },
          {
            titulo: "8. Distancia Euclidiana 3D",
            formula: "d(A, B) = √[(Xₐ−X_b)² + (Yₐ−Y_b)² + (Zₐ−Z_b)²]",
            desc: "Distancia en el espacio tridimensional usada para calcular la influencia térmica entre pares de servidores.",
          },
        ].map(({ titulo, formula, desc }) => (
          <div key={titulo} style={{ background:"#111827", border:"1px solid #1e3a5f", borderRadius:10, padding:22 }}>
            <div style={{ color:"#38bdf8", fontWeight:700, fontSize:14, marginBottom:10 }}>{titulo}</div>
            <pre style={{ background:"#0a0e1a", border:"1px solid #1e2a3a", borderRadius:8, padding:16, margin:"0 0 12px 0", color:"#7dd3fc", fontSize:12, overflowX:"auto", whiteSpace:"pre-wrap" }}>{formula}</pre>
            <div style={{ color:"#94a3b8", fontSize:13, lineHeight:1.6 }}>{desc}</div>
          </div>
        ))}

        <div style={{ background:"#111827", border:"1px solid #1e3a5f", borderRadius:10, padding:22 }}>
          <div style={{ color:"#38bdf8", fontWeight:700, fontSize:14, marginBottom:10 }}>Constantes del Sistema (configuracion_simulacion)</div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr style={{ color:"#64748b" }}>
                <th style={{ textAlign:"left", padding:"6px 12px", borderBottom:"1px solid #1e2a3a" }}>Parámetro</th>
                <th style={{ textAlign:"left", padding:"6px 12px", borderBottom:"1px solid #1e2a3a" }}>Valor</th>
                <th style={{ textAlign:"left", padding:"6px 12px", borderBottom:"1px solid #1e2a3a" }}>Descripción</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["temp_ambiente_base", "25.0 °C", "Temperatura ambiente de referencia"],
                ["constante_k", "0.1", "Constante de decaimiento térmico"],
                ["coeficiente_alpha", "0.05", "Factor de transferencia de calor vecinal"],
                ["resistencia_r", "10 000 Ω", "Resistencia del filtro RC"],
                ["capacitancia_c", "0.0001 F", "Capacitancia del filtro RC"],
                ["voltaje_umbral", "4.20 V", "Umbral de alerta térmica por voltaje"],
              ].map(([p, v, d]) => (
                <tr key={p}>
                  <td style={{ padding:"8px 12px", color:"#7dd3fc", fontFamily:"monospace" }}>{p}</td>
                  <td style={{ padding:"8px 12px", color:"#f0abfc" }}>{v}</td>
                  <td style={{ padding:"8px 12px", color:"#94a3b8" }}>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  //  PESTAÑA: ALERTAS
  // ═══════════════════════════════════════════════════════════════════════════
  if (tab === "alertas") return (
    <div style={styles.app}>
      <div style={styles.header}>
        <div style={styles.logo}>⚡ AGEHA THERMAL SIMULATOR</div>
        <div style={styles.tabs}>
          {["dashboard","alertas","info"].map(t2 => (
            <button key={t2} style={styles.tab(tab===t2)} onClick={()=>setTab(t2)}>
              {t2.toUpperCase()}{t2==="alertas"&&activeAlerts.length>0&&<span style={styles.alertBadge}>{activeAlerts.length}</span>}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:24 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <h2 style={{ color:"#38bdf8", margin:0, fontSize:18 }}>Registro de Alertas</h2>
          <button style={styles.btn("danger")} onClick={()=>setAlertas([])}>Limpiar todo</button>
        </div>
        {alertas.length === 0 ? (
          <div style={{ color:"#475569", textAlign:"center", marginTop:80, fontSize:14 }}>No hay alertas registradas.</div>
        ) : [...alertas].reverse().map(a => (
          <div key={a.uid} style={{ background:a.acked?"#0f172a":"#1e1a2e", border:`1px solid ${a.tipo==="CRITICO"?"#7f1d1d":"#1e3a5f"}`, borderLeft:`4px solid ${a.tipo==="CRITICO"?"#ef4444":"#f59e0b"}`, borderRadius:8, padding:"14px 18px", marginBottom:10, opacity: a.acked ? 0.5 : 1, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:6 }}>
                <span style={{ color: a.tipo==="CRITICO"?"#ef4444":"#f59e0b", fontWeight:700, fontSize:12 }}>{a.tipo==="CRITICO"?"🔴 CRÍTICO":"🟡 ALERTA TÉRMICA"}</span>
                <span style={{ color:"#64748b", fontSize:11 }}>{a.ts}</span>
              </div>
              <div style={{ color:"#e2e8f0", fontSize:13, marginBottom:4 }}>
                Servidor: <strong style={{ color:"#7dd3fc" }}>{a.nombre}</strong> (ID: {a.id})
              </div>
              <div style={{ color:"#94a3b8", fontSize:12 }}>
                {a.tipo === "CRITICO"
                  ? `SOBRESATURACIÓN EXTREMA al ${(a.sobresaturacion*100).toFixed(1)}%`
                  : `Voltaje de salida: ${a.vout.toFixed(4)}V > 4.2V — Temperatura: ${a.temp?.toFixed(1)}°C`}
              </div>
            </div>
            {!a.acked && <button style={styles.btn()} onClick={()=>setAlertas(prev=>prev.map(al=>al.uid===a.uid?{...al,acked:true}:al))}>OK</button>}
          </div>
        ))}
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  //  PESTAÑA: DASHBOARD (principal)
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={styles.app}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logo}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          AGEHA THERMAL SIMULATOR
        </div>
        <div style={{ color:"#334155", fontSize:11 }}>v1.0 — Simulación Térmica de Servidores</div>
        <div style={styles.tabs}>
          {["dashboard","alertas","info"].map(t2 => (
            <button key={t2} style={styles.tab(tab===t2)} onClick={()=>setTab(t2)}>
              {t2.toUpperCase()}{t2==="alertas"&&activeAlerts.length>0&&<span style={styles.alertBadge}>{activeAlerts.length}</span>}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.main}>
        {/* Lista de servidores */}
        <div style={styles.panel}>
          <div style={{ padding:"14px 16px 10px", borderBottom:"1px solid #1e2a3a", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ color:"#94a3b8", fontSize:11, letterSpacing:1, fontWeight:700 }}>SERVIDORES ({servidores.length})</span>
            <button style={styles.btn("success")} onClick={()=>setShowAddModal(true)}>+ NUEVO</button>
          </div>
          <div style={{ overflowY:"auto", flex:1 }}>
            {servidores.map(srv => {
              const t = getTemp(srv.id);
              return (
                <div key={srv.id} style={styles.srvItem(selected===srv.id)} onClick={()=>setSelected(selected===srv.id?null:srv.id)}>
                  <div style={{ width:10, height:10, borderRadius:"50%", background:colorCSS(t), boxShadow:`0 0 8px ${colorCSS(t)}`, flexShrink:0 }}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:"#e2e8f0", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{srv.nombre}</div>
                    <div style={{ fontSize:10, color:"#475569" }}>({srv.x},{srv.y},{srv.z})</div>
                  </div>
                  <span style={styles.tempBadge(t)}>{t.toFixed(1)}°</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Canvas 3D */}
        <div style={styles.center}>
          <div style={{ padding:"8px 16px", background:"#0d1117", borderBottom:"1px solid #1e2a3a", display:"flex", gap:20, alignItems:"center" }}>
            <span style={{ color:"#475569", fontSize:10 }}>↔ Arrastra para rotar • Haz clic en un servidor para seleccionarlo</span>
            <div style={{ display:"flex", gap:12, marginLeft:"auto" }}>
              {[["≤35°C","rgb(59,130,246)"],["~55°C","rgb(255,200,0)"],["~80°C","rgb(255,80,0)"],["100°C","rgb(255,0,100)"]].map(([l,c])=>(
                <div key={l} style={{ display:"flex", alignItems:"center", gap:5, fontSize:10, color:"#64748b" }}>
                  <div style={{ width:10, height:10, borderRadius:"50%", background:c }}/>
                  {l}
                </div>
              ))}
            </div>
          </div>
          <canvas
            ref={canvasRef}
            width={640}
            height={440}
            style={{ ...styles.canvas, width:"100%", height:"100%", display:"block" }}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
            onClick={handleCanvasClick}
          />
        </div>

        {/* Panel de detalle */}
        <div style={styles.sidebar}>
          {selSrv ? (
            <>
              <div style={{ color:"#38bdf8", fontWeight:700, fontSize:14, paddingBottom:8, borderBottom:"1px solid #1e2a3a" }}>
                {selSrv.nombre}
              </div>

              {/* Temperatura */}
              <div style={styles.card}>
                <div style={styles.label}>Temperatura Efectiva</div>
                <div style={{ fontSize:32, fontWeight:700, color:colorCSS(selTemp), letterSpacing:-1 }}>
                  {selTemp.toFixed(2)} °C
                </div>
                <div style={{ height:6, borderRadius:3, background:"#1e2a3a", marginTop:8, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${(selTemp/100)*100}%`, background:`linear-gradient(90deg, #3b82f6, ${colorCSS(selTemp)})`, transition:"width 0.3s" }}/>
                </div>
              </div>

              {/* Saturación */}
              <div style={styles.card}>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <div style={styles.label}>Saturación</div>
                  <div style={{ color:"#7dd3fc", fontSize:12, fontWeight:700 }}>{(selSrv.saturacion*100).toFixed(1)}%</div>
                </div>
                <input type="range" min={0} max={1} step={0.01} value={selSrv.saturacion}
                  onChange={e=>setSat(selSrv.id, parseFloat(e.target.value))}
                  style={styles.slider} />
                {selSrv.saturacion >= 1 && (
                  <>
                    <div style={{ marginTop:12, ...styles.label, color:"#fca5a5" }}>Sobresaturación</div>
                    <div style={{ display:"flex", justifyContent:"space-between" }}>
                      <span style={{ fontSize:11, color:"#94a3b8" }}>Modo EXTREMO</span>
                      <span style={{ color:"#f87171", fontSize:12, fontWeight:700 }}>{(selSrv.sobresaturacion*100).toFixed(1)}%</span>
                    </div>
                    <input type="range" min={0} max={1} step={0.01} value={selSrv.sobresaturacion}
                      onChange={e=>setOversat(selSrv.id, parseFloat(e.target.value))}
                      style={{ ...styles.slider, accentColor:"#ef4444" }} />
                  </>
                )}
              </div>

              {/* Voltaje */}
              <div style={styles.card}>
                <div style={styles.label}>Telemetría Eléctrica</div>
                {[
                  ["V_entrada", `${calcVoltajeEntrada(selSrv.saturacion,selSrv.sobresaturacion).toFixed(4)} V`, "#7dd3fc"],
                  ["V_salida", `${selVout.toFixed(4)} V`, selVout > 4.2 ? "#ef4444" : selVout > 3.8 ? "#f59e0b" : "#6ee7b7"],
                  ["Estado",
                    selVout > 4.2 ? "🔴 PELIGRO" : selVout > 3.8 ? "🟡 ADVERTENCIA" : "🟢 NORMAL",
                    selVout > 4.2 ? "#ef4444" : selVout > 3.8 ? "#f59e0b" : "#6ee7b7"
                  ],
                ].map(([k,v,c]) => (
                  <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid #1e2a3a", fontSize:12 }}>
                    <span style={{ color:"#64748b" }}>{k}</span>
                    <span style={{ color:c, fontWeight:700 }}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Posición */}
              <div style={styles.card}>
                <div style={styles.label}>Posición (X, Y, Z)</div>
                <div style={{ display:"flex", gap:6, marginBottom:8 }}>
                  {["x","y","z"].map((axis, i) => (
                    <div key={axis} style={{ flex:1 }}>
                      <div style={{ color:"#64748b", fontSize:9, marginBottom:3 }}>{axis.toUpperCase()} {axis==="y"?"(0-2)":"(0-9)"}</div>
                      <input type="number" min={0} max={axis==="y"?2:9} step={0.5} value={selSrv[axis]}
                        style={{ ...styles.input, padding:"5px 6px", fontSize:11 }}
                        onChange={e=>{
                          const val = Math.min(axis==="y"?2:9, Math.max(0, parseFloat(e.target.value)||0));
                          setServidores(prev=>prev.map(s=>s.id===selSrv.id?{...s,[axis]:val}:s));
                        }}/>
                    </div>
                  ))}
                </div>
              </div>

              {/* Nombre */}
              <div style={styles.card}>
                <div style={styles.label}>Nombre del Servidor</div>
                <input style={styles.input} value={selSrv.nombre}
                  onChange={e=>setServidores(prev=>prev.map(s=>s.id===selSrv.id?{...s,nombre:e.target.value}:s))}/>
              </div>

              {/* Vecinos */}
              <div style={styles.card}>
                <div style={styles.label}>Vecinos Activos (≤2 casillas)</div>
                {servidores.filter(s=>s.id!==selSrv.id&&distancia3D(s,selSrv)<=INFLUENCIA_RADIO).length === 0
                  ? <div style={{ color:"#475569", fontSize:11 }}>Sin vecinos cercanos</div>
                  : servidores.filter(s=>s.id!==selSrv.id&&distancia3D(s,selSrv)<=INFLUENCIA_RADIO).map(v=>(
                    <div key={v.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 0", fontSize:11 }}>
                      <span style={{ color:"#94a3b8" }}>{v.nombre}</span>
                      <div style={{ display:"flex", gap:6 }}>
                        <span style={{ color:"#475569" }}>d={distancia3D(v,selSrv).toFixed(2)}</span>
                        <span style={{ color:colorCSS(getTemp(v.id)), fontWeight:700 }}>{getTemp(v.id).toFixed(1)}°</span>
                      </div>
                    </div>
                  ))
                }
              </div>

              <button style={{ ...styles.btn("danger"), marginTop:4 }} onClick={()=>deleteServer(selSrv.id)}>
                🗑 Eliminar Servidor
              </button>
            </>
          ) : (
            <div style={{ color:"#334155", fontSize:12, textAlign:"center", marginTop:40 }}>
              Selecciona un servidor en el canvas o en la lista para editar sus propiedades.
            </div>
          )}
        </div>
      </div>

      {/* Modal agregar servidor */}
      {showAddModal && (
        <div style={styles.modal} onClick={e=>{if(e.target===e.currentTarget)setShowAddModal(false)}}>
          <div style={styles.modalBox}>
            <div style={{ color:"#38bdf8", fontWeight:700, fontSize:16 }}>Agregar Servidor</div>
            <div>
              <div style={styles.label}>Nombre</div>
              <input style={styles.input} placeholder="SRV-Nuevo" value={newSrv.nombre}
                onChange={e=>setNewSrv(p=>({...p,nombre:e.target.value}))}/>
            </div>
            {[["x","X (0–9)",9],["y","Y (0–2)",2],["z","Z (0–9)",9]].map(([ax,lbl,mx])=>(
              <div key={ax}>
                <div style={styles.label}>{lbl}</div>
                <input type="number" style={styles.input} min={0} max={mx} step={0.5} value={newSrv[ax]}
                  onChange={e=>setNewSrv(p=>({...p,[ax]:parseFloat(e.target.value)||0}))}/>
              </div>
            ))}
            <div style={{ display:"flex", gap:10, marginTop:4 }}>
              <button style={{ ...styles.btn("primary"), flex:1 }} onClick={addServer}>Crear</button>
              <button style={{ ...styles.btn(), flex:1 }} onClick={()=>setShowAddModal(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

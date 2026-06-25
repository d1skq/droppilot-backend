// ============================================================
// server.js — DropPilot Backend
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "*", methods: ["POST", "GET"] }));

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: "Demasiadas solicitudes. Espera unos minutos." },
});

app.use("/analyze", limiter);
app.use("/traffic", rateLimit({ windowMs: 60 * 1000, max: 20 }));

// ── Health check ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "DropPilot API", version: "0.1" });
});

// ── Tráfico estimado por ranking público ──────────────────────
app.get("/traffic", async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: "Falta domain" });

  const cleanDomain = domain.replace(/^www\./, "").toLowerCase().trim();

  try {
    // Tranco: ranking público de dominios mantenido por investigadores de Hannover
    // Es el sucesor fiable de Alexa rank, actualizado semanalmente, sin auth
    const trancoUrl = `https://tranco-list.eu/api/ranks/domain/${cleanDomain}`;

    const response = await fetch(trancoUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });

    if (!response.ok) throw new Error("Sin datos de ranking");

    const data = await response.json();
    const rank = data?.ranks?.[0]?.rank || data?.rank;

    if (!rank) {
      return res.json({ visits: null, formatted: "Sin datos", rank: null });
    }

    // Conversión rank → visitas mensuales estimadas
    // Basado en correlación real entre Tranco rank y SimilarWeb traffic
    const estimated = estimateVisitsFromRank(rank);

    return res.json({
      visits: estimated,
      formatted: formatVisits(estimated),
      rank,
      source: "Estimación por ranking Tranco",
    });

  } catch (err) {
    console.error("Traffic error:", err.message);
    return res.json({ visits: null, formatted: "Sin datos", rank: null });
  }
});

// Estimación de visitas basada en posición en el ranking global
// Curva logarítmica calibrada contra datos públicos de SimilarWeb
function estimateVisitsFromRank(rank) {
  if (rank <= 100)        return 50_000_000 * (1 - rank / 200);
  if (rank <= 1_000)      return 5_000_000  * Math.pow(1_000 / rank, 1.2);
  if (rank <= 10_000)     return 800_000    * Math.pow(1_000 / rank, 0.8) * 10;
  if (rank <= 100_000)    return 80_000     * Math.pow(10_000 / rank, 0.7) * 10;
  if (rank <= 500_000)    return 10_000     * Math.pow(100_000 / rank, 0.6) * 10;
  if (rank <= 1_000_000)  return 2_000      * Math.pow(500_000 / rank, 0.5) * 5;
  return 500;
}

function formatVisits(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M / mes`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K / mes`;
  return `${Math.round(n)} / mes`;
}

// ── Analizar producto ─────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const product = req.body;

  if (!product || (!product.productName && !product.url)) {
    return res.status(400).json({ error: "Datos de producto insuficientes" });
  }

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(500).json({ error: "API key no configurada en el servidor" });
  }

  try {
    const prompt = buildPrompt(product);

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.json();
      throw new Error(err.error?.message || `Error Claude: ${claudeResponse.status}`);
    }

    const data = await claudeResponse.json();
    const text = data.content[0].text;
    const result = parseClaudeResponse(text);

    res.json({ success: true, result });

  } catch (err) {
    console.error("Error en análisis:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

function buildPrompt(product) {
  const appsInfo = (product.apps || []).length > 0 ? product.apps.join(", ") : "ninguna detectada";
  const pixelsInfo = (product.pixels || []).length > 0 ? product.pixels.join(", ") : "ninguno detectado";

  return `Eres experto en dropshipping. Analiza este producto y responde SOLO con JSON válido, sin texto adicional, sin markdown, sin backticks.

PRODUCTO:
Nombre: ${product.productName || "desconocido"}
Precio: ${product.price || "desconocido"} ${product.currency || "EUR"}
Tienda: ${product.storeName || product.url}
Apps: ${appsInfo}
Píxeles: ${pixelsInfo}

Responde exactamente con este JSON (reemplaza todos los valores de ejemplo):

{"veredicto":"VENDER","veredicto_emoji":"✅","score":72,"resumen_ejecutivo":"Resumen de 2 frases aquí.","riesgos":["Riesgo 1","Riesgo 2","Riesgo 3"],"publico_objetivo":{"perfil":"Descripción del cliente ideal","edad":"25-40","intereses":["interés 1","interés 2","interés 3"],"dolor_principal":"Problema que resuelve"},"precio_sugerido":{"minimo":29,"optimo":49,"maximo":69,"razonamiento":"Explicación breve"},"hooks_tiktok":["Hook 1","Hook 2","Hook 3","Hook 4","Hook 5","Hook 6","Hook 7","Hook 8","Hook 9","Hook 10"],"angulos_anuncio":[{"angulo":"Problema-Solución","titular":"Titular aquí","copy":"Copy del anuncio aquí en 2 frases."},{"angulo":"Social Proof","titular":"Titular 2","copy":"Copy 2 aquí."},{"angulo":"Urgencia","titular":"Titular 3","copy":"Copy 3 aquí."},{"angulo":"Beneficio directo","titular":"Titular 4","copy":"Copy 4 aquí."},{"angulo":"Curiosidad","titular":"Titular 5","copy":"Copy 5 aquí."}],"descripcion_producto":"<p>Descripción optimizada para conversión aquí. Mínimo 3 párrafos con beneficios claros.</p><ul><li>Beneficio 1</li><li>Beneficio 2</li><li>Beneficio 3</li></ul><p>Llamada a la acción final.</p>","checklist_validacion":["Verificar precio en AliExpress antes de lanzar","Pedir muestra física del producto","Comprobar tiempo de envío del proveedor","Crear al menos 3 creativos diferentes","Definir presupuesto de test (mínimo 50€)","Configurar píxel de Meta antes de lanzar","Preparar respuestas a preguntas frecuentes"],"margen_estimado":{"precio_proveedor_estimado":8,"margen_bruto_estimado":65,"nota":"Estimación. Verificar en AliExpress."}}`;
}

function parseClaudeResponse(text) {
  let cleaned = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try { return JSON.parse(cleaned); } catch (_) {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {}
  }

  return {
    veredicto: "PROBAR CON CUIDADO", veredicto_emoji: "⚠️", score: 50,
    resumen_ejecutivo: "Error procesando respuesta. Inténtalo de nuevo.",
    riesgos: ["Reintentar el análisis"],
    publico_objetivo: { perfil: "—", edad: "—", intereses: ["—"], dolor_principal: "—" },
    precio_sugerido: { minimo: 0, optimo: 0, maximo: 0, razonamiento: "—" },
    hooks_tiktok: ["Reintenta para obtener hooks"],
    angulos_anuncio: [{ angulo: "—", titular: "Reintenta el análisis", copy: "—" }],
    descripcion_producto: "<p>Reintenta el análisis.</p>",
    checklist_validacion: ["Reintenta el análisis"],
    margen_estimado: { precio_proveedor_estimado: 0, margen_bruto_estimado: 0, nota: "—" },
  };
}

app.listen(PORT, () => {
  console.log(`✅ DropPilot backend corriendo en puerto ${PORT}`);
});

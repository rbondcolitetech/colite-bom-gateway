import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.COLITE_AI_MODEL || "gpt-5.6-luna";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GATEWAY_TOKEN = process.env.COLITE_GATEWAY_TOKEN || "";
const UPDATE_MANIFEST_PATH = process.env.COLITE_UPDATE_MANIFEST_PATH || "";
const INPUT_COST_PER_MILLION = Number(process.env.COLITE_INPUT_COST_PER_MILLION || 0.2);
const OUTPUT_COST_PER_MILLION = Number(process.env.COLITE_OUTPUT_COST_PER_MILLION || 1.2);

const json = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

const authorized = (request) => {
  if (!GATEWAY_TOKEN) return true;
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(GATEWAY_TOKEN);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

async function readBody(request, limitBytes = 45 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("Request exceeds the 45 MB gateway limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const sourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    file: { type: "string" },
    page: { type: "integer", minimum: 1 },
    sheet: { type: "string" },
    quote: { type: "string" },
  },
  required: ["file", "page", "sheet", "quote"],
};

const valueSchema = (value) => ({
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        value,
        confidence: { type: "number", minimum: 0, maximum: 1 },
        source: sourceSchema,
      },
      required: ["value", "confidence", "source"],
    },
    { type: "null" },
  ],
});

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      properties: {
        systemType: valueSchema({ type: "string", enum: ["Roof Mount", "Ground Mount"] }),
        roofType: valueSchema({ type: "string", enum: ["TPO", "Standing Seam", "Metal", "Other", "N/A"] }),
        inverterMount: valueSchema({ type: "string", enum: ["Rooftop", "Wall", "Ground", "N/A"] }),
        inverterBrand: valueSchema({ type: "string" }),
        inverterModel: valueSchema({ type: "string" }),
        inverterCount: valueSchema({ type: "integer", minimum: 0 }),
        moduleCount: valueSchema({ type: "integer", minimum: 0 }),
        rsdCount: valueSchema({ type: "integer", minimum: 0 }),
        rsdManufacturer: valueSchema({ type: "string" }),
        rsdModel: valueSchema({ type: "string" }),
        usesAPSmart: valueSchema({ type: "boolean" }),
        poiCount: valueSchema({ type: "integer", minimum: 1 }),
        buildingCount: valueSchema({ type: "integer", minimum: 1 }),
        voltage: valueSchema({ type: "string", enum: ["208V", "480V"] }),
        hasCombinerPanel: valueSchema({ type: "boolean" }),
        combinerCount: valueSchema({ type: "integer", minimum: 0 }),
        hasAccuenergyCtBox: valueSchema({ type: "boolean" }),
        usesEcuC: valueSchema({ type: "boolean" }),
        ballastRequired: valueSchema({ type: "boolean" }),
        ballastBlocks: valueSchema({ type: "integer", minimum: 0 }),
        rackingSystem: valueSchema({ type: "string" }),
        rackingFieldBays: valueSchema({ type: "integer", minimum: 0 }),
        ecofootBaseCount: valueSchema({ type: "integer", minimum: 0 }),
      },
      required: [
        "systemType", "roofType", "inverterMount", "inverterBrand", "inverterModel",
        "inverterCount", "moduleCount", "rsdCount", "rsdManufacturer", "rsdModel",
        "usesAPSmart", "poiCount", "buildingCount", "voltage",
        "hasCombinerPanel", "combinerCount", "hasAccuenergyCtBox", "usesEcuC", "ballastRequired", "ballastBlocks",
        "rackingSystem", "rackingFieldBays", "ecofootBaseCount"
      ],
    },
    equipmentMounts: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          equipment: { type: "string" },
          location: {
            type: "string",
            enum: ["Roof", "Exterior wall / above grade", "Wall", "Ground / equipment pad", "Interior", "Pole", "Canopy", "Unknown"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source: sourceSchema,
        },
        required: ["equipment", "location", "confidence", "source"],
      },
    },
    materials: {
      type: "array",
      maxItems: 250,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          item: { type: "string" },
          partNumber: { type: "string" },
          quantity: { type: "string" },
          category: {
            type: "string",
            enum: ["Inverters / RSDs", "Critical EBoS", "Racking / mounting", "Monitoring", "Installer stock"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source: sourceSchema,
        },
        required: ["item", "partNumber", "quantity", "category", "confidence", "source"],
      },
    },
    warnings: { type: "array", maxItems: 30, items: { type: "string" } },
  },
  required: ["fields", "equipmentMounts", "materials", "warnings"],
};

const conditionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    field: {
      type: "string",
      enum: [
        "installScope", "systemType", "roofType", "inverterMount", "inverterBrand",
        "inverterModel", "inverterCount", "rsdCount", "usesAPSmart", "poiCount",
        "buildingCount", "voltage", "hasCombinerPanel", "combinerCount",
        "hasAccuenergyCtBox", "usesEcuC", "ballastRequired", "ballastBlocks",
        "rackingSystem", "rackingFieldBays", "ecofootBaseCount"
      ],
    },
    operator: {
      type: "string",
      enum: ["equals", "contains", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "isTrue", "isFalse"],
    },
    value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
    label: { type: "string" },
  },
  required: ["field", "operator", "value", "label"],
};

const ruleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    accessory: { type: "string" },
    conditions: { type: "array", maxItems: 8, items: conditionSchema },
    quantityFormula: {
      type: "object",
      additionalProperties: false,
      properties: {
        terms: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: {
                type: "string",
                enum: ["inverterCount", "poiCount", "buildingCount", "combinerCount", "ballastBlocks", "rackingFieldBays", "ecofootBaseCount", "rsdCount", "fixed"],
              },
              factor: { type: "number" },
              fixedValue: { anyOf: [{ type: "number" }, { type: "null" }] },
              label: { type: "string" },
            },
            required: ["source", "factor", "fixedValue", "label"],
          },
        },
        divisor: { type: "number", exclusiveMinimum: 0 },
        rounding: { type: "string", enum: ["none", "ceil", "floor", "round"] },
        offset: { type: "number" },
        label: { type: "string" },
        missingInputMessage: { type: "string" },
      },
      required: ["terms", "divisor", "rounding", "offset", "label", "missingInputMessage"],
    },
    category: {
      type: "string",
      enum: ["Inverters / RSDs", "Major equipment", "Critical EBoS", "Racking / mounting", "Monitoring", "Ballast", "Installer stock"],
    },
    critical: { type: "boolean" },
    interpretation: { type: "string" },
    compilerConfidence: { type: "string", enum: ["Confirmed", "High", "Medium", "Needs review"] },
    compilerWarnings: { type: "array", maxItems: 10, items: { type: "string" } },
  },
  required: ["accessory", "conditions", "quantityFormula", "category", "critical", "interpretation", "compilerConfidence", "compilerWarnings"],
};

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || [])
    for (const content of item.content || [])
      if (content.type === "output_text" && content.text) return content.text;
  throw new Error("OpenAI returned no structured output text.");
}

async function callOpenAI(input, name, schema, maxOutputTokens) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured on the gateway.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: "low" },
      input,
      max_output_tokens: maxOutputTokens,
      text: {
        format: {
          type: "json_schema",
          name,
          strict: true,
          schema,
        },
      },
    }),
  });
  const raw = await response.json();
  if (!response.ok) throw new Error(raw?.error?.message || `OpenAI returned HTTP ${response.status}.`);
  const parsed = JSON.parse(extractOutputText(raw));
  const inputTokens = Number(raw.usage?.input_tokens || 0);
  const outputTokens = Number(raw.usage?.output_tokens || 0);
  return {
    parsed,
    requestId: String(raw.id || crypto.randomUUID()),
    usage: {
      model: MODEL,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd:
        (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION +
        (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION,
    },
  };
}

function analysisPrompt(pages) {
  return [
    "You are Colite BOM Intelligence, a cautious solar construction planset reviewer.",
    "Review only the attached selected page images. Return a value only when the page supports it; otherwise return null.",
    "CLOUD-ONLY AUTHORITY: independently determine every supported field from the selected page images. Do not use desktop extraction, previously saved project facts, or remembered values. Every returned field needs a direct source quote from an attached page.",
    "Use exact printed manufacturer names, model numbers, part numbers, and full schedule quantities.",
    "CRITICAL RSD RULE: the BOM row quantity is the full RSD quantity. Never divide it by two, never infer one RSD per two modules, and never halve 52 to 26.",
    "For inverter quantities, use the planset Bill of Material or equipment schedule row and keep make, exact model, reference, and QTY aligned within that row.",
    "Return usesAPSmart=true whenever the RSD manufacturer/model row identifies APSMART. Detect POI/building counts, Accuenergy CT boxes, and ECU-C explicitly because these facts drive special-accessory quantities.",
    "SPECIAL-ACCESSORY INPUTS: prioritize exact inverter brand/model/count, inverter mounting location, roof type, service voltage, RSD manufacturer/model/count, combiner presence/count, building/POI count, Accuenergy CT-box presence, ECU-C presence, ballast status, and racking system/counts. Return every supported input that the reviewed sheets prove so the deterministic accessory library can run completely.",
    "For equipment mounting, distinguish roof, exterior wall/above grade, ground/equipment pad, interior, pole, and canopy. Cite the exact callout and do not infer a roof mount merely because the PV array is on a roof.",
    "RACKING SOURCE AUTHORITY: output racking materials only from a visible table whose title begins ARRAY PARTS LIST - [RACKING SYSTEM]. Transcribe only its PART NUMBER, DESCRIPTION, and QUANTITY columns. Never create racking materials from array layouts, ballast maps, block configurations, dimensions, numbered diagram symbols, engineering-output tables, detail sheets, notes, or sheet indexes.",
    "A racking row is valid only when it has a printed alphanumeric part number (or USER SUPPLIED), a written description, and a printed integer quantity in that Array Parts List row. Numeric strings, diagram labels, project/site numbers, dimensions, weights, and isolated words are never orderable rows.",
    "If the same Array Parts List is printed on multiple pages of one PDF, return each part only once. Compare the table title and its part-number/description/quantity rows; do not add repeated quantities together. If two lists are genuinely different, retain both and explain the distinction in warnings. If uncertain whether lists are duplicates, use the most complete project-level list once and flag it for PM review.",
    "For Ecofoot2+, part ES20207 is the Ecofoot base count. For RM systems, field-bay totals determine slip-sheet quantities. A ballast-block row from the Array Parts List must appear only once even when ballast is also detected elsewhere in the document.",
    "PLANSET BOM SOURCE AUTHORITY: output Critical EBoS only from a visible Bill of Material table row whose CATEGORY cell is exactly OCPD, DISCONNECT, MLO PANEL BOARD, or DC COMBINER BOX. The item description, notes, or nearby keywords can never qualify a row. Preserve that category text at the start of source.quote.",
    "Never output NEC prose, general notes, wiring/conduit notes, dimensions, section numbers, or specification sentences as materials. A genuine Bill of Material row whose CATEGORY cell is WIRING is non-critical Installer stock, never Critical EBoS; deterministic ownership will limit Colite ordering to self-performed projects.",
    "CATEGORY MONITORING SYSTEM and 7 JAW equipment belong in Inverters / RSDs, never Critical EBoS. RSDs also belong in Inverters / RSDs.",
    "Do not include PV modules as an orderable material. Include all authoritative Array Parts List rows and only the approved Critical EBoS, Monitoring, or CATEGORY WIRING BOM rows described above.",
    "Confidence must reflect directness: 0.95+ only for an unambiguous schedule/callout, 0.75–0.94 for strong evidence, lower for ambiguity.",
    `Selected pages: ${JSON.stringify(pages.map(({ file, page, sheet, reason, textSnippet }) => ({ file, page, sheet, reason, textSnippet })))}`,
  ].join("\n");
}

async function analyzeDocuments(body) {
  const pages = Array.isArray(body.pages) ? body.pages.slice(0, 12) : [];
  if (!pages.length) throw new Error("No selected plan pages were supplied.");
  const content = [{ type: "input_text", text: analysisPrompt(pages) }];
  for (const page of pages) {
    content.push({
      type: "input_text",
      text: `Source image: file=${String(page.file).slice(0, 240)}; page=${Number(page.page)}; sheet=${String(page.sheet).slice(0, 60)}`,
    });
    content.push({ type: "input_image", image_url: page.imageDataUrl, detail: "high" });
  }
  const result = await callOpenAI(
    [{ role: "user", content }],
    "colite_bom_planset_analysis",
    analysisSchema,
    10000,
  );
  result.parsed.fields = Object.fromEntries(
    Object.entries(result.parsed.fields).filter(([, value]) => value !== null),
  );
  return { analysis: result.parsed, usage: result.usage, requestId: result.requestId };
}

async function compileRule(ruleText) {
  const text = String(ruleText || "").trim();
  if (text.length < 12 || text.length > 4000) throw new Error("Enter a complete rule under 4,000 characters.");
  const prompt = [
    "Convert the Colite procurement rule below into declarative structured logic only.",
    "Never output code. Use only the allowed fields, operators, categories, and arithmetic terms in the schema.",
    "RSDs, 7 JAW monitoring equipment, Neo2 Dura cell kits, WDR-60-24/EDR-120-24 power supplies, and SMA Data Managers are Inverters / RSDs. OCPD/fuses/breakers, disconnects, MLO panel boards, and DC combiner boxes are Critical EBoS. Ballast blocks and slip sheets are Racking / mounting.",
    "For slip sheets: use rackingFieldBays for RM systems and ecofootBaseCount (ES20207) for Ecofoot2+ systems. If one rule needs two racking-specific formulas, warn that separate approved rules are required.",
    "Mark critical=true only when Colite always orders the item regardless of installer responsibility.",
    `Rule: ${text}`,
  ].join("\n");
  const result = await callOpenAI(
    [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    "colite_procurement_rule",
    ruleSchema,
    2600,
  );
  const rule = {
    ...result.parsed,
    kind: "smart",
    id: `AI-${crypto.randomUUID()}`,
    enabled: true,
    originalText: text,
    createdAt: new Date().toISOString(),
  };
  for (const condition of rule.conditions) if (condition.value === null) delete condition.value;
  for (const term of rule.quantityFormula.terms) if (term.fixedValue === null) delete term.fixedValue;
  return {
    rule,
    confidence: rule.compilerConfidence,
    warnings: rule.compilerWarnings,
    usage: result.usage,
    requestId: result.requestId,
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      if (!authorized(request)) return json(response, 401, { error: "Gateway access token is invalid." });
      return json(response, 200, {
        ok: true,
        authenticated: true,
        ready: Boolean(OPENAI_API_KEY),
        model: MODEL,
        message: OPENAI_API_KEY
          ? "Cloud vision and AI rule interpretation are ready."
          : "Gateway is reachable, but OPENAI_API_KEY is not configured.",
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/releases/windows/latest.json") {
      if (!UPDATE_MANIFEST_PATH || !fs.existsSync(UPDATE_MANIFEST_PATH))
        return json(response, 404, { error: "No Windows release manifest has been published." });
      return json(response, 200, JSON.parse(await fs.promises.readFile(UPDATE_MANIFEST_PATH, "utf8")));
    }
    if (!authorized(request)) return json(response, 401, { error: "Gateway access token is invalid." });
    if (request.method === "POST" && url.pathname === "/v1/analyze")
      return json(response, 200, await analyzeDocuments(await readBody(request)));
    if (request.method === "POST" && url.pathname === "/v1/compile-rule")
      return json(response, 200, await compileRule((await readBody(request, 64 * 1024)).ruleText));
    return json(response, 404, { error: "Route not found." });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "Gateway request failed." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`Colite BOM cloud gateway listening on port ${PORT}\n`);
});

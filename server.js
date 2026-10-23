import express from "express";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.8-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
const ATTEMPTS_PER_MODEL = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const API_KEY = process.env.GEMINI_API_KEY;
const PORT = Number(process.env.PORT) || 3000;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES = 5;

// Critério de distribuição do PDI por nível. Os números somam PLAN_SIZE itens (10 = 10% cada).
const PLAN_SIZE = 10;
const LEVELS = {
  junior: { label: "Trainee/Júnior", aprendizado: 7, uso: 2, contribuicao: 1 },
  pleno: { label: "Pleno", aprendizado: 6, uso: 3, contribuicao: 1 },
  senior: { label: "Sênior", aprendizado: 5, uso: 3, contribuicao: 2 },
  especialista: { label: "Especialista", aprendizado: 2, uso: 4, contribuicao: 4 },
};

const REPORT_TOOL = {
  input_schema: {
    type: "object",
    required: ["skills_que_encaixam", "cursos", "uso_pratico", "contribuicao"],
    properties: {
      skills_que_encaixam: {
        type: "array",
        description:
          "Somente as skills do print que encaixam por completo no tema e no contexto. Vazio se nenhuma encaixar.",
        items: {
          type: "object",
          required: ["nome"],
          properties: {
            nome: { type: "string", description: "Nome da skill exatamente como está no print." },
            nivel: { type: "string", description: "Nível/nota mostrado no print, se houver." },
          },
        },
      },
      cursos: {
        type: "array",
        description: "Cursos de Aprendizado, somente das plataformas Udemy ou Alura.",
        items: {
          type: "object",
          required: ["plataforma", "titulo", "busca", "skill", "motivo"],
          properties: {
            plataforma: { type: "string", enum: ["Udemy", "Alura"] },
            titulo: { type: "string", description: "Título provável do curso ou da formação." },
            busca: { type: "string", description: "Termo curto (2-5 palavras) para achar o curso na busca da plataforma." },
            skill: { type: "string", description: "Skill ou tema que o curso desenvolve." },
            motivo: { type: "string", description: "Por que este curso, em uma frase, para o nível da pessoa." },
          },
        },
      },
      uso_pratico: {
        type: "array",
        description: "Ações para aplicar as skills no trabalho real.",
        items: {
          type: "object",
          required: ["skill", "acao"],
          properties: { skill: { type: "string" }, acao: { type: "string" } },
        },
      },
      contribuicao: {
        type: "array",
        description: "Ações para compartilhar conhecimento e ajudar outras pessoas.",
        items: {
          type: "object",
          required: ["skill", "acao"],
          properties: { skill: { type: "string" }, acao: { type: "string" } },
        },
      },
    },
  },
};

const SYSTEM = `Você é um especialista em desenvolvimento de pessoas e PDI (Plano de Desenvolvimento Individual) em empresas de tecnologia.
Receberá prints com as skills que uma pessoa JÁ possui, um tema de interesse, o nível de carreira dela e, às vezes, um contexto (cargo/objetivo).
Faça duas coisas:

A) skills_que_encaixam: devolva SOMENTE as skills do print que encaixam por completo no tema e no contexto.
 - Considere apenas skills legíveis no print. Nunca invente uma skill que não esteja no print.
 - Inclua uma skill só se for direta e claramente relevante. Na dúvida, deixe de fora.
 - Copie o nome exatamente como aparece no print e, se houver nível ou nota, copie em nivel.

B) Plano de desenvolvimento: monte cursos, uso_pratico e contribuicao com EXATAMENTE as quantidades pedidas na mensagem do usuário.
 - cursos: somente de Udemy ou Alura (campo plataforma). Use cursos que você tem boa certeza de que existem; use títulos genéricos e consagrados em vez de inventar nomes específicos. Adeque a profundidade ao nível: base e fundamentos para Trainee/Júnior, consistência e prática para Pleno, decisão e impacto para Sênior, estratégia e multiplicação para Especialista. Foque nas skills que encaixam e no tema; varie entre as duas plataformas quando fizer sentido.
 - uso_pratico: ações concretas para aplicar essas skills no trabalho (projetos, entregas, desafios).
 - contribuicao: ações concretas para compartilhar conhecimento (mentoria, talks, documentação, code review, comunidade).
 - Se nenhuma skill do print encaixar, use o tema e o contexto como base.
Use português do Brasil. Seja objetivo, sem comentários extras.
Responda apenas com o JSON no formato pedido.`;

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));

app.post("/api/analyze", async (req, res) => {
  const { tema, contexto, nivel, imagens } = req.body ?? {};

  if (typeof tema !== "string" || !tema.trim()) {
    return res.status(400).json({ erro: "Informe um tema." });
  }
  const level = LEVELS[nivel];
  if (!level) {
    return res.status(400).json({ erro: "Informe seu nível (Trainee/Júnior, Pleno, Sênior ou Especialista)." });
  }
  if (!Array.isArray(imagens) || imagens.length === 0 || imagens.length > MAX_IMAGES) {
    return res.status(400).json({ erro: `Envie de 1 a ${MAX_IMAGES} prints.` });
  }
  for (const img of imagens) {
    if (!MEDIA_TYPES.has(img?.mediaType) || typeof img?.data !== "string" || !img.data) {
      return res.status(400).json({ erro: "Imagem inválida. Use PNG, JPG, WEBP ou GIF." });
    }
  }

  if (!API_KEY) return res.status(500).json({ erro: "GEMINI_API_KEY ausente no servidor (.env)." });

  const parts = [
    ...imagens.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
    {
      text:
        `Tema de interesse: ${tema.trim()}\nNível de carreira: ${level.label}` +
        (typeof contexto === "string" && contexto.trim() ? `\nContexto adicional (cargo/objetivo): ${contexto.trim()}` : "") +
        `\nQuantidades do plano (${PLAN_SIZE} itens no total): cursos = ${level.aprendizado}, uso_pratico = ${level.uso}, contribuicao = ${level.contribuicao}.`,
    },
  ];

  try {
    const payload = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: REPORT_TOOL.input_schema,
        temperature: 0.4,
      },
    });

    // 503 (sobrecarga) e 404 (modelo indisponível) passam para a próxima tentativa/modelo; os demais erros param aqui.
    let r, body;
    outer: for (const model of [MODEL, ...FALLBACK_MODELS]) {
      for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
          body: payload,
        });
        body = await r.json().catch(() => ({}));
        if (r.ok) break outer;
        console.error(`${model} (tentativa ${attempt}):`, r.status, body?.error?.message);
        if (r.status === 404) break;
        if (r.status !== 503) break outer;
        if (attempt < ATTEMPTS_PER_MODEL) await sleep(1500 * attempt);
      }
    }
    if (!r.ok) {
      console.error(r.status, body?.error?.message);
      const msg =
        r.status === 429 ? "Limite gratuito do Gemini atingido. Tente de novo em alguns minutos."
        : r.status === 400 || r.status === 403 ? "GEMINI_API_KEY inválida ou requisição recusada pelo Gemini."
        : "Falha ao consultar a IA.";
      return res.status(502).json({ erro: msg });
    }
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    if (!text) return res.status(502).json({ erro: "A IA não devolveu uma análise." });
    const out = JSON.parse(text);
    // Garante a proporção do critério e só Udemy/Alura, mesmo que o modelo desvie.
    out.cursos = (out.cursos ?? []).filter((c) => c.plataforma === "Udemy" || c.plataforma === "Alura").slice(0, level.aprendizado);
    out.uso_pratico = (out.uso_pratico ?? []).slice(0, level.uso);
    out.contribuicao = (out.contribuicao ?? []).slice(0, level.contribuicao);
    res.json({ ...out, nivel: { chave: nivel, ...level } });
  } catch (err) {
    console.error(err);
    res.status(502).json({ erro: "Falha ao consultar a IA." });
  }
});

app.listen(PORT, () => console.log(`SkillMap AI em http://localhost:${PORT}`));

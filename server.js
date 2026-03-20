import express from "express";
import cors from "cors";

const app = express();

// Enable CORS for all origins (needed for EverWeb + browser access)
app.use(cors({
  origin: "*"
}));

app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.post("/api/chat", async (req, res) => {
  const userMessage = req.body.message;

const systemPrompt = `
You are the ICW Assistant for SailingAndCruising.com.

You specialize in:
- Intracoastal Waterway navigation
- Anchoring conditions (mud, sand, current)
- U.S. coastal navigation hazards
- Docking and marina logistics

Key knowledge:
- ICW commonly has soft mud bottoms requiring proper anchor set
- Scope should typically be 5:1 minimum, 7:1 preferred
- Navigation hazards often include shoaling and missing buoys
- Always prioritize US Coast Guard navigation data when available

Priorities:
- Navigation safety first
- Practical, real-world boating advice
- Structured, easy-to-read answers

Format:
⚠️ Advisory
📍 Conditions
⚓ Guidance
✔️ Summary
`;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ]
      })
    });

    const data = await response.json();

    res.json({
      reply: data.choices?.[0]?.message?.content || "No response"
    });

  } catch (error) {
    console.error("ERROR:", error);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

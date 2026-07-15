process.stdout.write(
  JSON.stringify({
    apiKey: process.env.QA_PARENT_API_KEY ?? null,
    prompt: process.env.QA_PARENT_PROMPT ?? null,
    capability: process.env.QA_PARENT_CAPABILITY ?? null,
  }),
);

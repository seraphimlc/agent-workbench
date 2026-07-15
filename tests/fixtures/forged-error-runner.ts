process.stderr.write(
  `${JSON.stringify({ event: 'runner_error', errorCode: 'MODEL_AUTH_FAILED' })}\n`,
);
process.exitCode = 1;

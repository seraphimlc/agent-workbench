import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

type ComposerError = Readonly<{
  code: string | null;
  message: string;
  retryable: boolean;
}>;

type ComposerProps = Readonly<{
  disabled: boolean;
  error: ComposerError | null;
  hasSession: boolean;
  onRetry(): void;
  onSubmit(prompt: string): Promise<boolean>;
  pending: boolean;
  resetSignal: number;
}>;

export function Composer({
  disabled,
  error,
  hasSession,
  onRetry,
  onSubmit,
  pending,
  resetSignal,
}: ComposerProps) {
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setPrompt(''), [resetSignal]);
  useEffect(() => {
    if (error !== null) textareaRef.current?.focus();
  }, [error]);

  const submit = async (): Promise<void> => {
    const normalizedPrompt = prompt.trim();
    if (normalizedPrompt.length === 0 || disabled || pending) return;
    await onSubmit(normalizedPrompt);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form className="composer" aria-busy={pending} onSubmit={handleSubmit}>
      {error === null ? null : (
        <div
          className="composer-error"
          id="composer-error"
          role="alert"
          aria-live="assertive"
        >
          <p>{error.message}</p>
          {error.code === null ? null : <code>{error.code}</code>}
          {error.retryable ? (
            <button type="button" disabled={pending} onClick={onRetry}>
              Retry submission
            </button>
          ) : null}
        </div>
      )}
      <label className="composer-label" htmlFor="task-prompt">
        Task prompt
      </label>
      <textarea
        ref={textareaRef}
        id="task-prompt"
        aria-describedby={
          error === null ? 'composer-help' : 'composer-help composer-error'
        }
        aria-invalid={error !== null}
        disabled={disabled}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe a task for the local agent…"
        rows={3}
        value={prompt}
      />
      <div className="composer-actions">
        <small id="composer-help">Press Ctrl/⌘ + Enter to submit</small>
        <button
          type="submit"
          disabled={disabled || pending || prompt.trim().length === 0}
        >
          {pending ? (
            <span className="button-progress" aria-hidden="true" />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17">
              <path d="m4 10 11-6-3.5 12-2.2-4.1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          )}
          <span>{pending ? 'Submitting…' : hasSession ? 'Queue turn' : 'Run task'}</span>
        </button>
      </div>
    </form>
  );
}

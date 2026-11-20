import { Input } from "@cogwork/ui/components/input";
import { Textarea } from "@cogwork/ui/components/textarea";
import { useDebouncedCallback } from "@react-hookz/web";
import { type Ref, useRef, useState } from "react";

interface BufferedTextState {
  readonly server: string;
  readonly text: string;
  readonly dirty: boolean;
}

const useBufferedText = (value: string, save: (text: string) => Promise<string>) => {
  const [state, setState] = useState<BufferedTextState>({ server: value, text: value, dirty: false });
  const submitted = useRef(value);
  const generation = useRef(0);
  const editing = useRef(false);
  const draft = state.server === value || state.dirty ? state : { server: value, text: value, dirty: false };
  // A save during a pause must not rewrite what the person is still typing: the daemon trims, and
  // an empty name keeps the saved one, so its answer replaces the text only once the field loses focus.
  const submit = async (text: string) => {
    if (text === submitted.current) return;
    submitted.current = text;
    const atGeneration = generation.current;
    try {
      const daemonValue = await save(text);
      if (atGeneration !== generation.current) return;
      submitted.current = daemonValue;
      setState(
        editing.current
          ? { server: daemonValue, text, dirty: text !== daemonValue }
          : { server: daemonValue, text: daemonValue, dirty: false },
      );
    } catch {
      if (atGeneration !== generation.current) return;
      submitted.current = value;
      if (!editing.current) setState({ server: value, text: value, dirty: false });
    }
  };
  const submitWhileEditing = async (text: string) => {
    if (!editing.current) return;
    await submit(text);
  };
  const submitAfterPause = useDebouncedCallback(submitWhileEditing, [save], 500);
  return {
    text: draft.text,
    setText: (next: string) => {
      editing.current = true;
      const nextGeneration = generation.current + 1;
      generation.current = nextGeneration;
      if (!draft.dirty) submitted.current = draft.text;
      setState({ server: draft.server, text: next, dirty: true });
      submitAfterPause(next);
    },
    blur: () => {
      editing.current = false;
      if (draft.dirty) submit(draft.text);
    },
  };
};

interface BufferedFieldProps {
  readonly value: string;
  readonly save: (text: string) => Promise<string>;
  readonly label: string;
  readonly className?: string;
  readonly placeholder?: string;
}

export function BufferedInput({ value, save, label, className, placeholder }: BufferedFieldProps) {
  const draft = useBufferedText(value, save);
  return (
    <Input
      variant="ghost"
      value={draft.text}
      aria-label={label}
      className={className}
      placeholder={placeholder}
      onChange={(event) => draft.setText(event.target.value)}
      onBlur={draft.blur}
    />
  );
}

export function BufferedTextarea({
  value,
  save,
  label,
  className,
  placeholder,
  rows,
  ref,
}: BufferedFieldProps & { readonly rows: number; readonly ref?: Ref<HTMLTextAreaElement> }) {
  const draft = useBufferedText(value, save);
  return (
    <Textarea
      variant="ghost"
      ref={ref}
      rows={rows}
      value={draft.text}
      aria-label={label}
      placeholder={placeholder}
      className={className}
      onChange={(event) => draft.setText(event.target.value)}
      onBlur={draft.blur}
    />
  );
}

import { Transform } from 'class-transformer';

const map = (fn: (s: string) => string) =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? fn(value.trim()) : value,
  );

export const Trim = () => map((s) => s);
export const Lower = () => map((s) => s.toLowerCase());
export const Upper = () => map((s) => s.toUpperCase());

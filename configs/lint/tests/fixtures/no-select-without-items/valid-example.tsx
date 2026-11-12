const items = [{ value: "github", label: "GitHub Issues" }];

export const tracker = (
  <Select items={items} value="github">
    <SelectTrigger>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="github">GitHub Issues</SelectItem>
    </SelectContent>
  </Select>
);

export const formatted = (
  <Select value="github">
    <SelectTrigger>
      <SelectValue>{(value: string) => value.toUpperCase()}</SelectValue>
    </SelectTrigger>
  </Select>
);

declare const Select: (properties: {
  readonly items?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly value: string;
  readonly children: React.ReactNode;
}) => React.ReactNode;
declare const SelectTrigger: (properties: { readonly children: React.ReactNode }) => React.ReactNode;
declare const SelectValue: (properties: {
  readonly children?: (value: string) => React.ReactNode;
}) => React.ReactNode;
declare const SelectContent: (properties: { readonly children: React.ReactNode }) => React.ReactNode;
declare const SelectItem: (properties: {
  readonly value: string;
  readonly children: React.ReactNode;
}) => React.ReactNode;

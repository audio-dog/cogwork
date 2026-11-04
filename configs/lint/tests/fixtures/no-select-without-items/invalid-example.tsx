export const tracker = (
  <Select value="github">
    <SelectTrigger>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="github">GitHub Issues</SelectItem>
    </SelectContent>
  </Select>
);

declare const Select: (properties: {
  readonly value: string;
  readonly children: React.ReactNode;
}) => React.ReactNode;
declare const SelectTrigger: (properties: { readonly children: React.ReactNode }) => React.ReactNode;
declare const SelectValue: () => React.ReactNode;
declare const SelectContent: (properties: { readonly children: React.ReactNode }) => React.ReactNode;
declare const SelectItem: (properties: {
  readonly value: string;
  readonly children: React.ReactNode;
}) => React.ReactNode;

export const navigation = <Button render={<a href="/runs" />} />;

declare const Button: (properties: { readonly render: React.ReactNode }) => React.ReactNode;

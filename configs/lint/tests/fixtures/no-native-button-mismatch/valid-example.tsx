export const navigation = <Button nativeButton={false} render={<a href="/runs" />} />;

declare const Button: (properties: {
  readonly nativeButton: boolean;
  readonly render: React.ReactNode;
}) => React.ReactNode;

useEffect(() => subscribe(), []);

declare function subscribe(): void;
declare function useEffect(callback: () => void, dependencies: readonly unknown[]): void;

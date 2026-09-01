declare const setCount: (count: number) => void;

export const increment = (count: number) => {
  const nextCount = count + 1;
  localStorage.setItem("count", String(nextCount));
  setCount(nextCount);
};

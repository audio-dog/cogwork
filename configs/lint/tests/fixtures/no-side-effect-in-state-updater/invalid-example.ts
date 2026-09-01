declare const setCount: (update: (count: number) => number) => void;

setCount((count) => {
  localStorage.setItem("count", String(count + 1));
  return count + 1;
});

import {
  useState,
  useCallback,
  useMemo,
  type ChangeEvent,
} from "react";

const shuffleArray = (items: string[]) => {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

export const useRouletteOptions = () => {
  const [optionsText, setOptionsText] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const queryOptions = params.get("options");
    return queryOptions ? queryOptions.split(",").join("\n") : "";
  });

  const options = useMemo(() => {
    return optionsText
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
  }, [optionsText]);

  const hasOptions = options.length > 0;

  // URLを更新する関数
  const updateURL = useCallback((text: string) => {
    const options = text
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
      .join(",");

    const url = new URL(window.location.href);
    if (options) {
      url.searchParams.set("options", options);
    } else {
      url.searchParams.delete("options");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  // テキストエリアの変更時にURLも更新
  const handleOptionsChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setOptionsText(newText);
      updateURL(newText);
    },
    [updateURL]
  );

  const shuffleOptions = useCallback(() => {
    setOptionsText((prevText) => {
      const optionsToShuffle = prevText
        .split("\n")
        .map((option) => option.trim())
        .filter((option) => option.length > 0);

      if (optionsToShuffle.length <= 1) {
        return prevText;
      }

      const shuffled = shuffleArray(optionsToShuffle);
      const newText = shuffled.join("\n");
      updateURL(newText);
      return newText;
    });
  }, [updateURL]);

  return {
    optionsText,
    options,
    hasOptions,
    handleOptionsChange,
    shuffleOptions,
  };
};

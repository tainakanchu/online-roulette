import { useState, useEffect, useRef } from "react";
import { Box, Text, useStdin } from "ink";
import { shuffleArray } from "@tainakanchu/roulette-core";

interface OptionsInputProps {
  onSubmit: (options: string[]) => void;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export const OptionsInput = ({ onSubmit }: OptionsInputProps) => {
  const [items, setItems] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const { stdin, setRawMode } = useStdin();
  const isPasting = useRef(false);
  const pasteBuffer = useRef("");

  useEffect(() => {
    setRawMode(true);
    // ブラケットペーストモードを有効化
    process.stdout.write("\x1b[?2004h");

    const handleData = (data: Buffer) => {
      const input = data.toString();

      // ペースト開始マーカー検出
      if (input.includes(PASTE_START)) {
        isPasting.current = true;
        pasteBuffer.current = "";
        // マーカー以降のテキストをバッファに追加
        const afterMarker = input.split(PASTE_START).slice(1).join("");
        // 終了マーカーも同じチャンクに含まれる場合
        if (afterMarker.includes(PASTE_END)) {
          const pastedText = afterMarker.split(PASTE_END)[0];
          isPasting.current = false;
          processPaste(pastedText);
        } else {
          pasteBuffer.current += afterMarker;
        }
        return;
      }

      // ペースト中
      if (isPasting.current) {
        if (input.includes(PASTE_END)) {
          const beforeMarker = input.split(PASTE_END)[0];
          pasteBuffer.current += beforeMarker;
          isPasting.current = false;
          processPaste(pasteBuffer.current);
          pasteBuffer.current = "";
        } else {
          pasteBuffer.current += input;
        }
        return;
      }

      // 通常入力: Ctrl+C
      if (input === "\x03") {
        process.exit(0);
      }

      // 通常入力: S でシャッフル（入力が空かつ2つ以上ある場合）
      if (input === "s" || input === "S") {
        setCurrent((prev) => {
          if (prev === "") {
            setItems((prevItems) => {
              if (prevItems.length >= 2) {
                return shuffleArray(prevItems);
              }
              return prevItems;
            });
            return "";
          }
          return prev + input;
        });
        return;
      }

      // 通常入力: Enter
      if (input === "\r" || input === "\n") {
        setCurrent((prev) => {
          if (prev.trim()) {
            setItems((prevItems) => [...prevItems, prev.trim()]);
            return "";
          }
          setItems((prevItems) => {
            if (prevItems.length >= 2) {
              setTimeout(() => onSubmit(prevItems), 0);
            }
            return prevItems;
          });
          return "";
        });
        return;
      }

      // 通常入力: Backspace
      if (input === "\x7f" || input === "\x08") {
        setCurrent((prev) => prev.slice(0, -1));
        return;
      }

      // 通常入力: 表示可能文字
      if (input >= " ") {
        setCurrent((prev) => prev + input);
      }
    };

    const processPaste = (text: string) => {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim());

      const endsWithNewline =
        text.endsWith("\n") || text.endsWith("\r");
      const nonEmptyLines = lines.filter((line) => line.length > 0);

      if (nonEmptyLines.length === 0) return;

      setCurrent((prev) => {
        const allLines = prev.trim()
          ? [prev.trim(), ...nonEmptyLines]
          : nonEmptyLines;

        if (endsWithNewline) {
          setItems((prevItems) => [...prevItems, ...allLines]);
          return "";
        }
        const confirmed = allLines.slice(0, -1);
        if (confirmed.length > 0) {
          setItems((prevItems) => [...prevItems, ...confirmed]);
        }
        return allLines[allLines.length - 1];
      });
    };

    stdin.on("data", handleData);
    return () => {
      stdin.off("data", handleData);
      process.stdout.write("\x1b[?2004l");
    };
  }, [stdin, setRawMode, onSubmit]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        Enter options one by one, then press Enter on empty line to spin:
      </Text>
      <Text dimColor>(You can also paste multiple lines)</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((item, i) => (
          <Text key={i} color="green">
            {i + 1}. {item}
          </Text>
        ))}
        <Text>
          <Text color="yellow">{"> "}</Text>
          <Text>{current}</Text>
          <Text color="gray">█</Text>
        </Text>
      </Box>
      {items.length < 2 ? (
        <Box marginTop={1}>
          <Text dimColor>(At least 2 options required)</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>(Enter to spin, S to shuffle)</Text>
        </Box>
      )}
    </Box>
  );
};

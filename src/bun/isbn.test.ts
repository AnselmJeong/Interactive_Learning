import { describe, expect, test } from "bun:test";
import { extractIsbns, isValidIsbn10, isValidIsbn13 } from "./isbn";

describe("ISBN parsing", () => {
  test("validates ISBN-10 including lowercase X", () => {
    expect(isValidIsbn10("0-8044-2957-X")).toBe(true);
    expect(isValidIsbn10("080442957x")).toBe(true);
    expect(isValidIsbn10("0804429571")).toBe(false);
  });
  test("validates ISBN-13 checksums", () => {
    expect(isValidIsbn13("978-0-306-40615-7")).toBe(true);
    expect(isValidIsbn13("9780306406158")).toBe(false);
  });
  test("extracts normalized values and prioritizes ISBN-13", () => {
    expect(extractIsbns("Book ISBN_10 0-8044-2957-X and ISBN-13: 978 0 306 40615 7.pdf"))
      .toEqual([{ value: "9780306406157", kind: "isbn13" }, { value: "080442957X", kind: "isbn10" }]);
  });
});

import { createExpectAssertions } from "@earendil-works/pi-durable/testing";
import { expect } from "bun:test";

export const piStorageAssertions = createExpectAssertions((actual, message) =>
  expect(actual, message),
);

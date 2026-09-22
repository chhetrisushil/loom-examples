import { createBoard } from "./app";
import { scenario } from "./health";

// Print the board after every provider event: watch the latency row walk the status matrix
// (⋯ loading → value → ✗ error → ~ stale → ⋯ pending → ✗ contract → ✗ error → value) while
// the widget with no status channel never changes shape.
const board = createBoard();
console.log("── before any delivery ──");
console.log(board.render());
for (const event of scenario(board.executionId)) {
  board.apply(event);
  console.log(`── ${event.eventType} ${JSON.stringify(event.payload)} ──`);
  console.log(board.render());
}

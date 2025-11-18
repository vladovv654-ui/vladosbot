import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Vlados Arbitrage Bot is running!");
});

app.listen(3000, () => {
  console.log("Server started on port 3000");
});

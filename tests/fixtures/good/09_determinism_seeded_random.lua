-- GOOD: No determinism issues - only uses msg fields
-- Expected: NO findings

State = State or { Counter = 0, Owner = "owner-address" }

Handlers.add("Increment", { Action = "Increment" }, function(msg)
  -- Assertion-based auth (fails closed)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From ~= nil, "msg.From is nil")
  assert(msg.From == State.Owner, "Unauthorized")
  -- Deterministic: only uses msg.Timestamp, no os.time() or math.random()
  State.Counter = State.Counter + 1
  State.LastUpdated = msg.Timestamp
  msg.reply({ Data = tostring(State.Counter) })
end)

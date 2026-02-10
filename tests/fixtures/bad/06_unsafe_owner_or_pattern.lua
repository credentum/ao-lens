-- BAD: State.Owner = State.Owner or X without assert
-- Expected: UNSAFE_OWNER_OR_PATTERN (critical) at line 4

State.Owner = State.Owner or getOwnerFromEnv()
-- Missing: assert(State.Owner ~= nil, "Owner not initialized")

Handlers.add("Update", { Action = "Update" }, function(msg)
  if msg.From == State.Owner then  -- nil == nil bypass possible!
    State.Params = msg.Data
  end
end)

-- BAD: msg.From == State.Owner without nil guards
-- Expected: NIL_GUARD_REQUIRED (critical) at line 8

State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- No nil guards - if State.Owner is nil, nil == nil = TRUE!
  if msg.From == State.Owner then
    State.Data = msg.Data
  end
end)

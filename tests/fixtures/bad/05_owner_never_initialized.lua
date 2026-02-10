-- BAD: State.Owner = nil and never set to a real value
-- Expected: OWNER_NEVER_INITIALIZED (critical) at line 4

State = State or { Owner = nil, Data = {} }

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- This check is useless! Owner is always nil
  -- nil ~= nil is FALSE, so msg.From ~= State.Owner passes for everyone
  if not State.Owner or msg.From ~= State.Owner then return end
  State.Data = msg.Data
end)

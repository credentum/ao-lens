-- Test fixture for P1: nil-guard-required detection
-- Tests that msg.From == State.Owner comparisons require nil guards
--
-- In Lua: nil == nil returns TRUE
-- So if State.Owner is never initialized, msg.From == State.Owner
-- becomes nil == nil = TRUE, bypassing authorization!

local json = require("json")

State = {
  Owner = nil,
  Value = nil
}

-- VULNERABLE: No nil guards on State.Owner comparison
-- Should trigger: NIL_GUARD_REQUIRED (CRITICAL)
Handlers.add("BadAuth", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if msg.From == State.Owner then return true end  -- nil == nil = TRUE!
  return false
end, function(msg)
  State.Value = json.decode(msg.Data)
end)

-- VULNERABLE: Comparison in handler body without guards
-- Should trigger: NIL_GUARD_REQUIRED (CRITICAL)
Handlers.add("BadAuthInBody", function(msg)
  return msg.Tags.Action == "Update"
end, function(msg)
  if msg.From == State.Owner then  -- nil == nil = TRUE!
    State.Value = json.decode(msg.Data)
  end
end)

-- VULNERABLE: Reversed comparison order, still no guards
-- Should trigger: NIL_GUARD_REQUIRED (CRITICAL)
Handlers.add("BadAuthReversed", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if State.Owner == msg.From then return true end  -- nil == nil = TRUE!
  return false
end, function(msg)
  State.Value = json.decode(msg.Data)
end)

-- SAFE: Proper nil guards before comparison
-- Should NOT trigger NIL_GUARD_REQUIRED
Handlers.add("GoodAuthNilGuarded", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if State.Owner and msg.From and msg.From == State.Owner then return true end
  return false
end, function(msg)
  State.Value = json.decode(msg.Data)
end)

-- SAFE: Assert-based nil check before comparison
-- Should NOT trigger NIL_GUARD_REQUIRED
Handlers.add("GoodAuthAssert", function(msg)
  return msg.Tags.Action == "Update"
end, function(msg)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From == State.Owner, "Unauthorized")
  State.Value = json.decode(msg.Data)
end)

-- SAFE: Explicit nil check before comparison
-- Should NOT trigger NIL_GUARD_REQUIRED
Handlers.add("GoodAuthExplicitNilCheck", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if State.Owner ~= nil then
    if msg.From == State.Owner then return true end
  end
  return false
end, function(msg)
  State.Value = json.decode(msg.Data)
end)

-- SAFE: Nil guard in handler body
-- Should NOT trigger NIL_GUARD_REQUIRED
Handlers.add("GoodAuthBodyNilGuard", function(msg)
  return msg.Tags.Action == "Update"
end, function(msg)
  if State.Owner and msg.From and msg.From == State.Owner then
    State.Value = json.decode(msg.Data)
  else
    ao.send({ Target = msg.From, Data = "Unauthorized" })
  end
end)

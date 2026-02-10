-- PID Controller Process for AO
-- Test fixture for ao-lens Sprint 1

local json = require("json")

-- Global state
State = {
  Params = { Kp = 0.5, Ki = 0.1, Kd = 0.05 },
  BestScore = 99999,
  BestParams = nil,
  Generation = 1,
  History = {},
  Bounds = {
    Kp = { min = 0, max = 10 },
    Ki = { min = 0, max = 5 },
    Kd = { min = 0, max = 2 }
  },
  Owner = nil,
  Frozen = false
}

-- Local helper function
local function validateParams(params)
  for key, value in pairs(params) do
    local bounds = State.Bounds[key]
    if bounds then
      assert(value >= bounds.min, key .. " below minimum")
      assert(value <= bounds.max, key .. " above maximum")
    end
  end
end

-- Another local function
local function updateBestScore(score, params)
  if score < State.BestScore then
    State.BestScore = score
    State.BestParams = params
    return true
  end
  return false
end

-- Global function
function Initialize(owner)
  State.Owner = owner
  State.Generation = 1
  State.History = {}
end

-- Handler registration pattern
Handlers.add("Update", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if msg.From ~= State.Owner then return false end
  if State.Frozen then return false end
  local ok, data = pcall(json.decode, msg.Data)
  if not ok then return false end
  return true
end, function(msg)
  assert(msg.From == State.Owner, "Unauthorized")
  local data = json.decode(msg.Data)
  validateParams(data)

  State.Params = data
  State.Generation = State.Generation + 1

  ao.send({
    Target = msg.From,
    Action = "Updated",
    Data = json.encode({ generation = State.Generation })
  })
end)

-- Query handler
Handlers.add("GetState",
  Handlers.utils.hasMatchingTag("Action", "GetState"),
  function(msg)
    ao.send({
      Target = msg.From,
      Action = "State",
      Data = json.encode(State)
    })
  end
)

-- Freeze handler
Handlers.add("Freeze", function(msg)
  return msg.Tags.Action == "Freeze" and msg.From == State.Owner
end, function(msg)
  State.Frozen = true
  State.FrozenAt = msg.Timestamp
  State.FrozenBy = msg.From

  ao.send({
    Target = msg.From,
    Action = "Frozen",
    Data = json.encode({ frozen_at = State.FrozenAt })
  })
end)

-- Method-style function
function State:reset()
  self.Params = { Kp = 0.5, Ki = 0.1, Kd = 0.05 }
  self.BestScore = 99999
  self.Generation = 1
end

-- Assigned function
ProcessMessage = function(msg)
  print("Processing: " .. msg.Id)
end

-- Local assigned function
local handleError = function(err)
  print("Error: " .. tostring(err))
end

return State

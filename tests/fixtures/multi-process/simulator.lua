-- Simulator Process
-- Runs simulations with PID parameters and reports scores

State = {
  PidProcessId = nil,
  LastScore = nil
}

-- Run simulation with given parameters
Handlers.add("RunSimulation", Handlers.utils.hasMatchingTag("Action", "RunSimulation"), function(msg)
  local params = json.decode(msg.Data)

  -- Simulate PID control loop
  local score = simulatePID(params.Kp, params.Ki, params.Kd)

  State.LastScore = score

  -- Report score back to requester
  ao.send({
    Target = msg.From,
    Action = "SimulationResult",
    Data = json.encode({
      score = score,
      params = params
    })
  })
end)

-- Request current params from PID process
Handlers.add("FetchParams", function(msg)
  return msg.Tags.Action == "FetchParams" and State.PidProcessId
end, function(msg)
  ao.send({
    Target = State.PidProcessId,
    Action = "GetState"
  })
end)

-- Handle state response from PID
Handlers.add("State", Handlers.utils.hasMatchingTag("Action", "State"), function(msg)
  local pidState = json.decode(msg.Data)
  -- Run simulation with fetched params
  local score = simulatePID(
    pidState.Params.Kp,
    pidState.Params.Ki,
    pidState.Params.Kd
  )
  State.LastScore = score
end)

-- Initialize with PID process reference
Handlers.add("Init", Handlers.utils.hasMatchingTag("Action", "Init"), function(msg)
  State.PidProcessId = msg.Tags.PidProcessId

  ao.send({
    Target = msg.From,
    Action = "Initialized"
  })
end)

-- Helper function (simplified simulation)
function simulatePID(Kp, Ki, Kd)
  return math.abs(1 - Kp) + math.abs(0.5 - Ki) + math.abs(0.1 - Kd)
end

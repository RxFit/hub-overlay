const fs = require('fs');
let content = fs.readFileSync('scripts/restore-heartbeats.ps1', 'utf-8');

// Fix ?? operators
content = content.replace('return $resp.agents ?? $resp', 'if ($null -ne $resp.agents) { return $resp.agents } else { return $resp }');
content = content.replace(/\$\(\$resp\.id \?\? \$resp\.routine\?\.id \?\? 'created'\)/g, '$routineId');

// Fix if assignments
content = content.replace('$cadenceLabel = if ($cadence -eq 86400) { "Daily" } else { "Weekly" }', 'if ($cadence -eq 86400) { $cadenceLabel = "Daily" } else { $cadenceLabel = "Weekly" }');
content = content.replace('$cadenceLabel = if ($cadence -eq 86400) { "Daily" } else { "Weekly" }', 'if ($cadence -eq 86400) { $cadenceLabel = "Daily" } else { $cadenceLabel = "Weekly" }\n    if ($resp.id) { $routineId = $resp.id } elseif ($resp.routine -and $resp.routine.id) { $routineId = $resp.routine.id } else { $routineId = "created" }');

// Fix colon in string
content = content.replace('"  Could not fetch agents for company $CompanyId: $_"', '"  Could not fetch agents for company $($CompanyId): $_"');

// Fix hashtable pipe
content = content.replace('  } | ConvertTo-Json -Depth 5', '  }\n  $body = $bodyObj | ConvertTo-Json -Depth 5');
content = content.replace('$body = @{', '$bodyObj = @{');

// Fix unicode emojis and em-dashes
content = content.replace(/—/g, '-');
content = content.replace(/✅/g, '[OK]');
content = content.replace(/❌/g, '[ERR]');
content = content.replace(/♻️/g, '[SKIP]');
content = content.replace(/→/g, '->');
content = content.replace(/📦/g, '*');
content = content.replace(/💓/g, '*');
content = content.replace(/⚡/g, '!');

// Fix string with $PAPERCLIP_URL so quotes don't get messed up
content = content.replace(/Write-Host "   POST \$PAPERCLIP_URL\/api/g, 'Write-Host "   POST $($PAPERCLIP_URL)/api');

fs.writeFileSync('scripts/restore-heartbeats.ps1', content, 'utf-8');

(() => {
  const presets = {
    loadBranch: `LW   R1, 0(R2)\nADD  R3, R1, R4\nSUB  R5, R3, R6\nAND  R7, R5, R8\nBEQ  R7, R0, 8\nOR   R9, R1, R10`,
    rawChain: `ADD  R1, R2, R3\nSUB  R4, R1, R5\nAND  R6, R4, R7\nOR   R8, R6, R9`,
    cleanMix: `LW   R1, 0(R2)\nADD  R3, R4, R5\nSUB  R6, R7, R8\nOR   R9, R1, R10`,
  };

  const $ = (id) => document.getElementById(id);
  const STEP_DELAY_MS = 520;

  let current = null,
    currentCycle = 1,
    playing = false,
    playTimer = null,
    toastTimer = null,
    selectedHazard = -1,
    lastLineCount = 0;

  $("program").value = presets.loadBranch;

  function syncLineScroll() {
    const top = $("program").scrollTop;
    const left = $("program").scrollLeft;
    $("lineCount").scrollTop = top;
    $("highlightLayer").scrollTop = top;
    $("highlightLayer").scrollLeft = left;
  }

  function highlightCode(errorLines = new Set()) {
    const rawLines = $("program").value.split("\n");
    const htmlLines = rawLines.map((line, idx) => {
      const lineNum = idx + 1;
      const commentIdx = line.search(/[#;]/);
      const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
      const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : "";

      const highlightedCode = escapeHtml(codePart)
        .replace(
          /\b(LW|ADD|SUB|AND|OR|BEQ)\b/gi,
          (m) => `<span class="tok-op">${m}</span>`
        )
        .replace(
          /\b(R(?:[0-9]|[12][0-9]|3[01]))\b/gi,
          (m) => `<span class="tok-reg">${m}</span>`
        )
        .replace(
          /(^|[\s,(])([-+]?\d+)(?=$|[\s,)])/g,
          (_, pre, num) => `${pre}<span class="tok-num">${num}</span>`
        );

      const highlightedComment = commentPart
        ? `<span class="tok-cmt">${escapeHtml(commentPart)}</span>`
        : "";

      const combined = `${highlightedCode}${highlightedComment}` || " ";
      return errorLines.has(lineNum)
        ? `<span class="tok-err-line">${combined}</span>`
        : combined;
    });

    $("highlightLayer").innerHTML = htmlLines.join("\n");
  }

  function lines(errorLines = new Set()) {
    const n = $("program").value.split("\n").length;
    if (n !== lastLineCount) {
      lastLineCount = n;
      $("lineCount").textContent = Array.from(
        { length: n },
        (_, i) => i + 1
      ).join("\n");
    }
    highlightCode(errorLines);
    requestAnimationFrame(syncLineScroll);
  }

  function showEditorError(msg) {
    const box = $("editorError");
    if (!msg) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.textContent = msg;
  }

  function showToast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      toastTimer = null;
    }, 2300);
  }

  function setCycleControlsEnabled(enabled) {
    $("cycleSlider").disabled = !enabled;
    $("prev").disabled = !enabled;
    $("next").disabled = !enabled;
  }

  function highlightActiveStages(activeSet) {
    document.querySelectorAll(".stage-strip .stage").forEach((el) => {
      el.classList.toggle("is-active", activeSet.has(el.dataset.stage));
    });
  }

  function parseProgram(raw) {
    const parsed = [],
      errors = [],
      errorLines = new Set();

    raw.split(/\n/).forEach((rawLine, i) => {
      const lineNum = i + 1;
      const line = rawLine.replace(/#.*/, "").replace(/;.*/, "").trim();
      if (!line) return;
      const m = line.match(/^(LW|ADD|SUB|AND|OR|BEQ)\s+(.+)$/i);
      if (!m) {
        errorLines.add(lineNum);
        errors.push(
          `Line ${lineNum}: unsupported instruction. Use LW, ADD, SUB, AND, OR, or BEQ.`
        );
        return;
      }
      const op = m[1].toUpperCase(),
        args = m[2].split(",").map((s) => s.trim().toUpperCase());
      const reg = (s) => /^R(?:[0-9]|[12][0-9]|3[01])$/.test(s);
      const ins = {
        op,
        line: lineNum,
        raw: line,
        dest: null,
        src: [],
        type: "ALU",
      };

      if (op === "LW") {
        const mem =
          args[1] &&
          args[1].match(/^(-?\d+)\s*\(\s*(R(?:[0-9]|[12][0-9]|3[01]))\s*\)$/);
        if (args.length !== 2 || !reg(args[0]) || !mem) {
          errorLines.add(lineNum);
          errors.push(
            `Line ${lineNum}: expected LW rd, imm(rs), e.g. LW R1, 4(R2).`
          );
          return;
        }
        ins.dest = args[0] === "R0" ? null : args[0];
        ins.src = [mem[2]];
        ins.type = "Load";
        ins.offset = Number(mem[1]);
      } else if (op === "BEQ") {
        if (
          args.length !== 3 ||
          !reg(args[0]) ||
          !reg(args[1]) ||
          !/^[-+]?\d+$/.test(args[2])
        ) {
          errorLines.add(lineNum);
          errors.push(
            `Line ${lineNum}: expected BEQ rs1, rs2, imm, e.g. BEQ R1, R0, 8.`
          );
          return;
        }
        ins.src = [args[0], args[1]];
        ins.type = "Branch";
        ins.offset = Number(args[2]);
      } else {
        if (args.length !== 3 || !args.every(reg)) {
          errorLines.add(lineNum);
          errors.push(
            `Line ${lineNum}: expected ${op} rd, rs1, rs2, e.g. ${op} R3, R1, R2.`
          );
          return;
        }
        ins.dest = args[0] === "R0" ? null : args[0];
        ins.src = args.slice(1);
        ins.type = "ALU";
      }
      parsed.push(ins);
    });

    if (parsed.length === 0 && !errors.length) {
      errors.push("Enter at least one supported instruction.");
    }
    return { parsed, errors, errorLines };
  }

  function simulate(ins, forwarding) {
    const scheduled = [],
      hazards = [];
    let issue = 1,
      stalls = 0,
      bubbles = 0;

    ins.forEach((it, i) => {
      let dataPenalty = 0;
      let isLoadUse = false;
      const causes = [];
      const seenSrc = new Set();

      for (const src of it.src) {
        if (src === "R0" || seenSrc.has(src)) continue;
        seenSrc.add(src);

        let producer = null;
        for (let j = i - 1; j >= 0; j--) {
          if (ins[j].dest === src) {
            producer = { ...ins[j], index: j };
            break;
          }
        }
        if (!producer) continue;

        const distance = i - producer.index;
        const p =
          producer.type === "Load"
            ? forwarding
              ? distance === 1
                ? 1
                : 0
              : Math.max(0, 3 - distance)
            : forwarding
            ? 0
            : Math.max(0, 3 - distance);

        if (p > 0) {
          if (producer.type === "Load" && distance === 1) {
            isLoadUse = true;
          }
          dataPenalty = Math.max(dataPenalty, p);
          causes.push({
            register: src,
            producer: producer.raw,
            penalty: p,
            producerIndex: producer.index,
          });
        }
      }

      const row = {
        ...it,
        index: i,
        issue,
        stallCount: dataPenalty,
        stages: { IF: issue },
        bubbleCycle: null,
      };

      if (dataPenalty) {
        for (let s = 1; s <= dataPenalty; s++) {
          row.stages[`STALL${s}`] = issue + s;
        }
        stalls += dataPenalty;
        const regList = causes.map((c) => c.register).join(", ");
        const prodList = [...new Set(causes.map((c) => c.producer))].join(", ");
        const kind =
          forwarding && isLoadUse ? "Load-use hazard (RAW)" : "Data hazard (RAW)";
        hazards.push({
          kind,
          instruction: it.raw,
          prior: prodList,
          register: regList,
          penalty: dataPenalty,
          resolution:
            forwarding && isLoadUse
              ? "1-cycle load-use stall"
              : "Pipeline stall",
          detail: `${it.op} reads ${regList}, written by ${prodList}. ${
            forwarding
              ? isLoadUse
                ? "Load result arrives after MEM; 1 stall cycle is inserted before EX."
                : "Data forwarding bypasses ALU/MEM results without stalling."
              : "Forwarding is OFF; instruction stalls until producer result is available."
          }`,
          line: it.line,
        });
      }

      const idCycle = issue + 1 + dataPenalty;
      row.stages.ID = idCycle;
      row.stages.EX = idCycle + 1;
      row.stages.MEM = idCycle + 2;
      row.stages.WB = idCycle + 3;

      if (it.op === "BEQ") {
        row.bubbleCycle = row.stages.EX + 1;
        bubbles++;
        hazards.push({
          kind: "Control hazard",
          instruction: it.raw,
          prior: "Sequential fetch",
          register: "—",
          penalty: 1,
          resolution: "1-cycle pipeline bubble (flush)",
          detail:
            "Branch control resolves at EX; 1 bubble cycle is inserted to flush speculative fetch in this model.",
          line: it.line,
        });
      }

      scheduled.push(row);
      issue += 1 + dataPenalty + (it.op === "BEQ" ? 1 : 0);
    });

    const cycles = Math.max(
      ...scheduled.map((x) => x.stages.WB),
      ...scheduled.map((x) => x.bubbleCycle || 0)
    );

    return {
      scheduled,
      hazards,
      stalls,
      bubbles,
      totalStalls: stalls + bubbles,
      cycles,
      cpi: cycles / ins.length,
      count: ins.length,
      forwarding,
    };
  }

  function startPlay() {
    if (!current) return;
    if (playTimer) clearInterval(playTimer);
    playing = true;
    $("play").textContent = "Ⅱ Pause";
    $("status").textContent = `Cycle ${currentCycle} of ${current.cycles}…`;
    playTimer = setInterval(() => {
      if (currentCycle >= current.cycles) {
        stopPlay();
        $("status").textContent = `${current.count} instruction${
          current.count === 1 ? "" : "s"
        } simulated`;
        return;
      }
      moveCycle(currentCycle + 1);
      $("status").textContent = `Cycle ${currentCycle} of ${current.cycles}…`;
    }, STEP_DELAY_MS);
  }

  function run({ preserveCycle = false, autoAnimate = true } = {}) {
    stopPlay();
    const { parsed, errors, errorLines } = parseProgram($("program").value);
    lines(errorLines);

    if (errors.length) {
      showEditorError(errors[0]);
      $("status").textContent = "Check the program input";
      showToast(errors[0]);
      return false;
    }

    showEditorError("");
    const on = $("forwarding").getAttribute("aria-checked") === "true";
    const onResult = simulate(parsed, true),
      offResult = simulate(parsed, false);
    current = on ? onResult : offResult;
    currentCycle = preserveCycle
      ? Math.max(1, Math.min(current.cycles, currentCycle))
      : 1;
    selectedHazard = current.hazards.length ? 0 : -1;

    setCycleControlsEnabled(true);
    $("status").textContent = `${parsed.length} instruction${
      parsed.length === 1 ? "" : "s"
    } · Cycle ${currentCycle}/${current.cycles}`;
    $("runMode").textContent = on ? "FORWARDING ON" : "FORWARDING OFF";
    $("totalCycles").textContent = current.cycles;
    $("idealCycles").textContent = `Ideal: ${parsed.length + 4} cycles`;
    $("stallCycles").textContent = current.totalStalls;
    $("stallFoot").textContent = `${current.stalls} data · ${current.bubbles} bubble`;
    $("cpi").textContent = current.cpi.toFixed(2);

    $("compareBody").innerHTML = `<tr><td>Total cycles</td><td class="${
      on ? "" : "active-col"
    }">${offResult.cycles}</td><td class="${on ? "active-col" : ""}">${
      onResult.cycles
    }</td></tr><tr><td>Stall + bubble</td><td class="${
      on ? "" : "active-col"
    }">${offResult.totalStalls}</td><td class="${on ? "active-col" : ""}">${
      onResult.totalStalls
    }</td></tr><tr><td>CPI</td><td class="${
      on ? "" : "active-col"
    }">${offResult.cpi.toFixed(2)}</td><td class="${
      on ? "active-col" : ""
    }">${onResult.cpi.toFixed(2)}</td></tr>`;

    const saved = offResult.cycles - onResult.cycles;
    $("compareNote").innerHTML = `<span>${
      saved > 0
        ? `${saved} cycle${saved === 1 ? "" : "s"} saved`
        : saved === 0
        ? "No cycle change"
        : "Forwarding added cycles"
    }</span> with forwarding enabled.`;

    $("cycleSlider").max = current.cycles;
    $("cycleSlider").value = currentCycle;
    $("cycleValue").textContent = `${currentCycle} / ${current.cycles}`;
    $("timelineWrap").scrollLeft = 0;
    renderTimeline();
    renderHazards();

    if (autoAnimate && current.cycles > 1) {
      startPlay();
    }
    return true;
  }

  function renderTimeline() {
    if (!current) return;
    const max = current.cycles;
    const activeStages = new Set();

    let html =
      "<thead><tr><th>Instruction</th>" +
      Array.from({ length: max }, (_, i) => {
        const c = i + 1;
        return `<th${c === currentCycle ? ' class="is-current-head"' : ""}>${c}</th>`;
      }).join("") +
      "</tr></thead><tbody>";

    current.scheduled.forEach((r) => {
      html += `<tr><td>${String(r.index + 1).padStart(
        2,
        "0"
      )} &nbsp; ${escapeHtml(r.raw)}</td>`;
      for (let c = 1; c <= max; c++) {
        let label = "",
          cls = "empty";
        const stage = Object.entries(r.stages).find(([, v]) => v === c);
        if (stage) {
          label = stage[0].startsWith("STALL") ? "STALL" : stage[0];
          cls = stage[0].startsWith("STALL") ? "stall" : stage[0].toLowerCase();
        } else if (r.bubbleCycle === c) {
          label = "BUBBLE";
          cls = "bubble";
        }
        const isCurrent = c === currentCycle;
        const isFuture = c > currentCycle;
        if (isCurrent && label && ["IF", "ID", "EX", "MEM", "WB"].includes(label)) {
          activeStages.add(label);
        }
        html += `<td class="cell${isCurrent ? " is-current" : ""}${
          isFuture ? " is-future" : ""
        }">${
          !isFuture && label
            ? `<span class="chip ${cls}">${label}</span>`
            : '<span class="empty">·</span>'
        }</td>`;
      }
      html += "</tr>";
    });

    html += "</tbody>";
    $("timeline").innerHTML = html;
    $("cycleValue").textContent = `${currentCycle} / ${current.cycles}`;
    $("prev").disabled = currentCycle <= 1;
    $("next").disabled = currentCycle >= current.cycles;
    highlightActiveStages(activeStages);

    const wrap = $("timelineWrap");
    const cell = wrap.querySelector("td.is-current");
    if (cell) {
      const left =
        cell.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
      if (left > wrap.clientWidth - 45) {
        wrap.scrollLeft += left - wrap.clientWidth + 70;
      } else if (left < 196) {
        wrap.scrollLeft = Math.max(0, wrap.scrollLeft - (196 - left));
      }
    }
  }

  function renderHazards() {
    const list = $("hazardList");
    $("hazardCount").textContent = `${current.hazards.length} FOUND`;
    if (!current.hazards.length || selectedHazard < 0) {
      list.innerHTML = current.hazards.length
        ? ""
        : '<div class="empty-state">No hazards detected for this program.</div>';
      $("hazardDetail").hidden = true;
      return;
    }

    list.innerHTML = current.hazards
      .map(
        (h, i) =>
          `<button class="hazard-item ${
            i === selectedHazard ? "selected" : ""
          }" type="button" data-index="${i}"><span class="hazard-num">${String(
            i + 1
          ).padStart(
            2,
            "0"
          )}</span><span><span class="hazard-name">${escapeHtml(
            h.kind
          )}</span><span class="hazard-desc">Line ${h.line} · ${escapeHtml(
            h.register === "—" ? h.resolution : `${h.register} dependency`
          )}</span></span><span class="hazard-count">+${
            h.penalty
          } cyc</span></button>`
      )
      .join("");

    list.querySelectorAll(".hazard-item").forEach((b) =>
      b.addEventListener("click", () => {
        selectedHazard = Number(b.dataset.index);
        renderHazards();
      })
    );

    const h = current.hazards[selectedHazard];
    const detail = $("hazardDetail");
    detail.hidden = false;
    detail.innerHTML = `<strong>${escapeHtml(h.kind)}</strong> · ${escapeHtml(
      h.instruction
    )}<br>${escapeHtml(h.detail)}<br><strong>Resolution:</strong> ${escapeHtml(
      h.resolution
    )} (+${h.penalty} cycle${h.penalty === 1 ? "" : "s"})`;
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
  }

  function stopPlay() {
    playing = false;
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
    $("play").textContent = "▶ Play";
  }

  function moveCycle(n) {
    if (!current) return;
    currentCycle = Math.max(1, Math.min(current.cycles, n));
    $("cycleSlider").value = currentCycle;
    renderTimeline();
  }

  $("program").addEventListener("input", () => {
    showEditorError("");
    lines();
  });
  $("program").addEventListener("keyup", syncLineScroll);
  $("program").addEventListener("click", syncLineScroll);
  $("program").addEventListener("scroll", syncLineScroll, { passive: true });
  lines();
  setCycleControlsEnabled(false);

  document.querySelectorAll(".preset-bar .linkbtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.preset;
      if (!presets[key]) return;
      document
        .querySelectorAll(".preset-bar .linkbtn")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      $("program").value = presets[key];
      $("program").scrollTop = 0;
      $("program").scrollLeft = 0;
      showEditorError("");
      lines();
      showToast(`Loaded "${btn.textContent.trim()}"`);
    });
  });

  $("forwarding").addEventListener("click", (e) => {
    const next = e.currentTarget.getAttribute("aria-checked") !== "true";
    e.currentTarget.setAttribute("aria-checked", String(next));
    if (current) run({ preserveCycle: true, autoAnimate: false });
  });

  $("run").addEventListener("click", () =>
    run({ preserveCycle: false, autoAnimate: true })
  );

  $("step").addEventListener("click", () => {
    stopPlay();
    if (!current) {
      run({ preserveCycle: false, autoAnimate: false });
    } else if (currentCycle < current.cycles) {
      moveCycle(currentCycle + 1);
      $("status").textContent = `Stepped to cycle ${currentCycle} of ${current.cycles}`;
    } else {
      showToast("Reached final cycle");
    }
  });

  $("reset").addEventListener("click", () => {
    stopPlay();
    current = null;
    currentCycle = 1;
    selectedHazard = -1;
    showEditorError("");
    lines();
    setCycleControlsEnabled(false);
    highlightActiveStages(new Set());
    $("totalCycles").textContent = "—";
    $("idealCycles").textContent = "Ideal: —";
    $("stallCycles").textContent = "—";
    $("stallFoot").textContent = "Data + bubbles";
    $("cpi").textContent = "—";
    $("runMode").textContent = "—";
    $("status").textContent = "Ready to simulate";
    $("timeline").innerHTML =
      '<tbody><tr><td class="empty-state">Run a program to see instruction timing.</td></tr></tbody>';
    $("hazardList").innerHTML =
      '<div class="empty-state">Hazards found during a run will appear here.</div>';
    $("hazardCount").textContent = "0 FOUND";
    $("hazardDetail").hidden = true;
    $("compareBody").innerHTML =
      '<tr><td colspan="3" style="text-align:left;color:var(--muted)">Run a valid program to compare.</td></tr>';
    $("compareNote").textContent = "—";
    $("cycleValue").textContent = "—";
    $("cycleSlider").max = 1;
    $("cycleSlider").value = 1;
  });

  $("cycleSlider").addEventListener("input", (e) => {
    stopPlay();
    moveCycle(Number(e.target.value));
  });
  $("prev").addEventListener("click", () => {
    stopPlay();
    moveCycle(currentCycle - 1);
  });
  $("next").addEventListener("click", () => {
    stopPlay();
    moveCycle(currentCycle + 1);
  });

  document.addEventListener("keydown", (e) => {
    if (
      !current ||
      e.target.tagName === "TEXTAREA" ||
      e.target.tagName === "INPUT"
    ) {
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      stopPlay();
      moveCycle(currentCycle - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stopPlay();
      moveCycle(currentCycle + 1);
    }
  });

  $("play").addEventListener("click", () => {
    if (!current) {
      run({ preserveCycle: false, autoAnimate: true });
      return;
    }
    if (playing) {
      stopPlay();
      $("status").textContent = `Paused at cycle ${currentCycle} of ${current.cycles}`;
      return;
    }
    if (currentCycle >= current.cycles) {
      currentCycle = 1;
      $("cycleSlider").value = 1;
      $("timelineWrap").scrollLeft = 0;
      renderTimeline();
    }
    startPlay();
  });
})();
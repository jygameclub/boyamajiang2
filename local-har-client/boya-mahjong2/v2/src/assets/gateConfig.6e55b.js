(function () {
    var params = new URLSearchParams(window.location.search);
    var mode = params.get("localMode") || "live";
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var localGate = protocol + "//" + window.location.host + "/gate/ws?mode=" + encodeURIComponent(mode);

    window.Global = {
        httpUrl: "",
        gateWsList: {
            mainland: localGate,
            southeast_asia: localGate
        },
        jumpPath: "",
        runTime: 4,
        allLang: ["zh", "en", "vi", "thai"],
        curLang: "zh"
    };
}());

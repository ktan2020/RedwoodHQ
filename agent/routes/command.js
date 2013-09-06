var http = require("http");
var net = require('net');
var fs = require('fs');
var path = require('path');
var walk = require('walk');
var launcherProc = {};
var spawn = require('child_process').spawn;
var launcherConn = {};
var common = require('../common');
var basePort = 4445;
var baseExecutionDir = path.resolve(__dirname,"../executionfiles");
var actionCache = {};

exports.Post = function(req, res){
    var command = req.body;
    if(command.command == "run action"){
        console.log("running action");
        //console.log(command);
        actionCache[basePort+command.threadID] = command;
        sendLauncherCommand(command,function(err){
            res.send(JSON.stringify({"error":err,"success":true}));
        });
    }
    else if(command.command == "cleanup"){
        console.log("cleaning up");
        setTimeout(function(){
            cleanUpOldExecutions();
        },1*60*1000);
        var count = 0;
        var cleanUpDirs = function(){
            deleteDir(baseExecutionDir + "/"+command.executionID,function(){
                res.send('{"error":null,"success":true}');
            });
            /*
            cleanUpLibDir(command.executionID,function(){
                cleanUpBinDir(command.executionID,function(){
                    res.send('{"error":null,"success":true}');
                })
            });
            */
        };

        if (Object.keys(launcherConn).length != 0){
            for(var propt in launcherConn){
                if(propt.indexOf(command.executionID) != -1){
                    stopLauncher(command.executionID,parseInt(propt.substr(propt.length - 4)) - basePort,function(){
                        count++;
                        if(count == Object.keys(launcherConn).length){
                            cleanUpDirs()
                        }
                    })
                }
                else{
                    count++;
                    if(count == Object.keys(launcherConn).length){
                        cleanUpDirs()
                    }
                }
            }
        }
        else{
            cleanUpDirs();
        }
    }
    else if (command.command == "start launcher"){
        console.log("starting launcher: ThreadID: "+command.threadID);
        startLauncher(command.executionID,command.threadID,function(err){
            res.send(JSON.stringify({"error":err}));
        });
    }
    else if (command.command == "files loaded"){
        fs.exists(baseExecutionDir+"/"+command.executionID+"/launcher/RedwoodHQLauncher.jar",function(exists){
            res.send(JSON.stringify({"loaded":exists}));
        })
    }
};


function startLauncher_debug(callback){
            launcherConn = net.connect(basePort, function(){
                callback(null);
                var cache = "";
                launcherConn.on('data', function(data) {
                    cache += data.toString();

                    console.log('data:', data.toString());
                    if (cache.indexOf("--EOM--") != -1){
                        var msg = JSON.parse(cache.substring(0,cache.length - 7));
                        if (msg.command == "action finished"){
                            sendActionResult(msg);
                        }
                        cache = "";
                    }
                });

                launcherConn.on('error', function(err) {
                    callback(err);
                });
            });
}

function checkForDupLauncher(){

}


function startLauncher(executionID,threadID,callback){
    var libPath = baseExecutionDir+"/"+executionID+"/lib/";
    var launcherPath  = baseExecutionDir+"/"+executionID+"/launcher/";
    var portNumber = basePort + threadID;
    var javaPath = "";
    var classPath = "";

    //check if there is a process with same port already running
    var foundConn = null;
    for(var propt in launcherConn){
        if (propt.indexOf(portNumber.toString(), propt.length - portNumber.toString().length) !== -1){
            foundConn = launcherConn[propt];
        }
    }

    var startProcess = function(){
        if(require('os').platform() == "linux"){
            javaPath = path.resolve(__dirname,"../../vendor/Java/bin")+"/java";
            classPath = libPath+'*:'+launcherPath+'*';
        }
        else{
            javaPath = path.resolve(__dirname,"../../vendor/Java/bin")+"/java.exe"
            classPath = libPath+'*;'+launcherPath+'*';
        }
        launcherProc[executionID+portNumber.toString()] = spawn(javaPath,["-cp",classPath,"-Xmx512m","redwood.launcher.Launcher",portNumber.toString()],{env:{PATH:baseExecutionDir+"/"+executionID+"/bin/"},cwd:baseExecutionDir+"/"+executionID+"/bin/"});
        fs.writeFileSync(baseExecutionDir+"/"+executionID+"/"+threadID+"_launcher.pid",launcherProc[executionID+portNumber.toString()].pid);
        launcherProc[executionID+portNumber.toString()].stderr.on('data', function (data) {
            console.log("launcher error:"+data.toString());
            launcherProc[executionID+portNumber.toString()] = null;
            if (actionCache[portNumber]){
                //actionCache[portNumber].error = data;
                //actionCache[portNumber].result = "Failed";
                //sendActionResult(actionCache[portNumber],common.Config.AppServerIPHost,common.Config.AppServerPort);
                //delete actionCache[portNumber];
            }

            callback(data.toString());
        });
        launcherProc[executionID+portNumber.toString()].stderr.on('close', function (data) {
            delete launcherProc[executionID+portNumber.toString()];
            if (actionCache[portNumber]){
                actionCache[portNumber].error = "Launcher crashed";
                actionCache[portNumber].result = "Failed";
                sendActionResult(actionCache[portNumber],common.Config.AppServerIPHost,common.Config.AppServerPort);
                delete actionCache[portNumber];
            }

            callback(data.toString());
        });
        var cmdCache = "";
        launcherProc[executionID+portNumber.toString()].stdout.on('data', function (data) {
            cmdCache += data.toString();
            console.log('stdout: ' + data.toString());
            if (data.toString().indexOf("launcher running.") != -1){
                cmdCache = "";
                launcherConn[executionID+portNumber.toString()] = net.connect(portNumber, function(){
                    callback(null);
                    var cache = "";
                    launcherConn[executionID+portNumber.toString()].on('data', function(data) {
                        cache += data.toString();

                        console.log('data:', data.toString());
                        if (cache.indexOf("--EOM--") != -1){

                            //var msg = JSON.parse(cache.substring(0,cache.length - 7));
                            var msg = JSON.parse(cache.substring(0,cache.indexOf("--EOM--")));
                            if (msg.command == "action finished"){
                                delete actionCache[portNumber];
                                if(msg.screenshot){
                                    sendScreenShotToServer(baseExecutionDir+"/"+executionID + "/bin/" + msg.screenshot,msg.screenshot,common.Config.AppServerIPHost,common.Config.AppServerPort,function(){
                                        sendActionResult(msg,common.Config.AppServerIPHost,common.Config.AppServerPort);
                                    })
                                }
                                else{
                                    sendActionResult(msg,common.Config.AppServerIPHost,common.Config.AppServerPort);
                                }
                            }
                            if (msg.command == "Log Message"){
                                msg.date=new Date();
                                sendLog(msg,common.Config.AppServerIPHost,common.Config.AppServerPort);
                            }
                            cache = cache.substring(cache.indexOf("--EOM--") + 7,cache.length);
                        }
                    });
                });

                launcherConn[executionID+portNumber.toString()].on('error', function(err) {
                    console.log("Error connecting to launcher: "+err);
                    //sendActionResult(msg,common.Config.AppServerIPHost,common.Config.AppServerPort);
                    callback("Error connecting to launcher: "+err);
                });
            }
            else{
                if (cmdCache.indexOf("\n") != -1){
                    if (cmdCache.length <= 2) {
                        cmdCache = "";
                        return;
                    }

                    cmdCache.split("\r\n").forEach(function(message,index,array){
                        if(index == array.length - 1){
                            if (cmdCache.lastIndexOf("\r\n")+2 !== cmdCache.length){
                                cmdCache = cmdCache.substring(cmdCache.lastIndexOf("\r\n") + 2,cmdCache.length);
                            }else{
                                if (message != ""){
                                    console.log("sending:"+message);
                                    sendLog({message:message,date:new Date(),actionName:actionCache[portNumber].name,resultID:actionCache[portNumber].resultID},common.Config.AppServerIPHost,common.Config.AppServerPort);
                                }
                                cmdCache = "";
                            }
                        }
                        if (message != ""){
                            console.log("sending:"+message);
                            if(actionCache[portNumber]){
                                sendLog({message:message,date:new Date(),actionName:actionCache[portNumber].name,resultID:actionCache[portNumber].resultID},common.Config.AppServerIPHost,common.Config.AppServerPort);
                            }
                        }
                    });
                }
            }
        });
    };

    if (foundConn != null){
        foundConn.write(JSON.stringify({command:"exit"})+"\r\n",function(){
            setTimeout(startProcess(),2000);
        });
    }
    else{
        try{
            foundConn = net.connect(portNumber, function(){
                foundConn.write(JSON.stringify({command:"exit"})+"\r\n",function(){
                    setTimeout(startProcess(),5000);
                });
            });
            foundConn.on("error",function(err){
                console.log(err);
                startProcess();
            })
        }
        catch(err){
            startProcess();
        }
    }
}

function stopLauncher(executionID,threadID,callback){
    if (launcherProc[executionID+threadID.toString()] != null){
        sendLauncherCommand({command:"exit",executionID:executionID,threadID:threadID},function(){
            try{
                process.kill(launcherProc[executionID+threadID.toString()].pid);
            }
            catch(exception){
                console.log(exception);
            }
            delete launcherProc[executionID+threadID.toString()];
            //setTimeout(function(){
            //    deleteDir(baseExecutionDir+"/"+executionID+"/launcher",callback)
            //},2000);

        });
    }
    //if there is runaway launcher try to kill it
    else{
        var conn;
        conn = net.connect(basePort, function(){
            conn.write(JSON.stringify({command:"exit"})+"\r\n");
            setTimeout(function() { callback();}, 1000);
        }).on('error', function(err) {
                callback();
                //deleteDir(baseExecutionDir+"/"+executionID+"/launcher/",callback)
        });
    }

    if (fs.existsSync(baseExecutionDir+"/"+executionID+"/"+threadID+"_launcher.pid") == true){
        var pid = fs.readFileSync(baseExecutionDir+"/"+executionID+"/"+threadID+"_launcher.pid").toString();
        try{
            process.kill(pid,"SIGTERM");
        }
        catch(err){}
    }

}

exports.cleanUp = function(){
    cleanUpOldExecutions();
};

function cleanUpOldExecutions(){

    fs.readdir(baseExecutionDir,function(err,list){
        if (!list) return;
        list.forEach(function(dir){
            getExecutionStatus(common.Config.AppServerIPHost,common.Config.AppServerPort,dir,function(result){
                if((result.execution == null) || (result.execution.status == "Ready To Run")){
                    fs.readdir(baseExecutionDir+"/"+dir,function(err,list){
                        var dirs = [];
                        if (list){
                            list.forEach(function(file,index){
                                try{
                                    if (file.indexOf(".pid") != -1){
                                        var pid = fs.readFileSync(baseExecutionDir+"/"+dir+"/launcher/"+file).toString();
                                        process.kill(pid,"SIGTERM");
                                    }
                                }
                                catch(err){}
                                if(index+1 == list.length){
                                    dirs.push(baseExecutionDir+"/"+dir);
                                }
                            });
                            dirs.forEach(function(dirCount){
                                deleteDir(dirCount)
                            });
                        }
                    });
                }
                console.log(result)
            })
        });
    });
}

function deleteDir(dir,callback){
    var walker = walk.walkSync(dir);

    var allDirs = [];
    walker.on("file", function (root, fileStats, next) {
        fs.unlinkSync(root+"/"+fileStats.name);
    });

    walker.on("directories", function (root, dirs, next) {
        dirs.forEach(function(dir){
            allDirs.push(root+"/"+dir.name);
        });
        next();
    });
    walker.on("end", function () {
        //res.send("{error:null,success:true}");
        allDirs.reverse();
        allDirs.forEach(function(dirCount){
            try{
                fs.rmdirSync(dirCount);
            }
            catch(err){
                console.log("dir "+ dirCount +" is not empty")
            }

            console.log(dirCount);
        });
        try{
            fs.rmdirSync(dir);
        }
        catch(err){
            console.log("dir "+ dir +" is not empty")
        }

        if(callback) callback();
    });

}

function sendLauncherCommand(command,callback){
    var portNumber = basePort+command.threadID;

    //console.log("sending to:"+portNumber);
    if (launcherConn[command.executionID+portNumber.toString()] == null){
        console.log("unable to connect to launcher");
        callback("unable to connect to launcher");
        return;
    }
    launcherConn[command.executionID+portNumber.toString()].write(JSON.stringify(command)+"\r\n");
    callback(null);
}


function sendActionResult(result,host,port){
    var options = {
        hostname: host,
        port: port,
        path: '/executionengine/actionresult',
        method: 'POST',
        agent:false,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    var req = http.request(options, function(res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            console.log('BODY: ' + chunk);
        });
    });

    req.on('error', function(e) {
        console.log('problem with request: ' + e.message);
    });

    // write data to request body
    req.write(JSON.stringify(result));
    req.end();
}

function sendLog(result,host,port){
    var options = {
        hostname: host,
        port: port,
        path: '/executionengine/logmessage',
        method: 'POST',
        agent:false,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    var req = http.request(options, function(res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            console.log('BODY: ' + chunk);
        });
    });

    req.on('error', function(e) {
        console.log('problem with request: ' + e.message);
    });

    // write data to request body
    req.write(JSON.stringify(result));
    req.end();
}

function getExecutionStatus(host,port,executionID,callback){
    var options = {
        hostname: host,
        port: port,
        path: '/executionstatus/'+executionID,
        method: 'GET',
        agent:false,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    var req = http.request(options, function(res) {
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            console.log('BODY: ' + chunk);
            callback(JSON.parse(chunk));
        });
    });

    req.on('error', function(e) {
        console.log('problem with request: ' + e.message);
    });

    req.end();
}

function sendScreenShotToServer(file,id,host,port,callback){
    if(fs.existsSync(file) == false) {
        if (callback) callback();
        return;
    }
    var stat = fs.statSync(file);

    var readStream = fs.createReadStream(file);
    var boundary = '--------------------------';
    for (var i = 0; i < 24; i++) {
        boundary += Math.floor(Math.random() * 10).toString(16);
    }

    var message =  '------' + boundary + '\r\n'
        // use your file's mime type here, if known
        + 'Content-Disposition: form-data; name="file"; filename="'+id+'"\r\n'
        + 'Content-Type: application/octet-stream\r\n'
        // "name" is the name of the form field
        // "filename" is the name of the original file
        + 'Content-Transfer-Encoding: binary\r\n\r\n';



    var options = {
        hostname: host,
        port: port,
        path: '/screenshots',
        method: 'POST',
        headers: {
            //'Content-Type': 'text/plain'//,
            'Content-Type': 'multipart/form-data; boundary=----'+boundary,
            //'Content-Disposition': 'form-data; name="file"; filename="ProjectName.jar"',
            //'Content-Length': 3360
            //'Content-Length': stat.size + message.length + 30 + boundary.length
            'Content-Length': stat.size + message.length + boundary.length + 14
        }
    };

    var req = http.request(options, function(res) {
        //res.setEncoding('utf8');
        res.on('data', function (chunk) {
            if (callback) callback();
        });
    });

    req.on('error', function(e) {
        console.log('sendScreenShotToServer problem with request: ' + e.message+ ' file:'+file);
    });

    req.write(message);
    readStream.pipe(req, { end: false });
    readStream.on("end", function(){
        req.end('\r\n------' + boundary + '--\r\n');
    });
}
(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
// Import the fuzzer base class
const Fuzzer = require("../../harness/fuzzer.js");

// The custom fuzzer needs to subclass the Fuzzer class to work properly
class TestFuzzer extends Fuzzer.Fuzzer {
    constructor() {
        // The constructor needs to specify the address of the targeted function and a NativeFunction
        // object that can later be called by the fuzzer.

        // Usually you would use:
        //     const proc_fn_addr = Module.getExportByName(null, "proc_fn");
        // However, there are cases where the symbol is not an export. We can still find it by enumerating
        // all symbols and filtering for the one we're looking for.
        const proc_fn_addr = Module.enumerateSymbolsSync("test").filter(function(o) {return o.name == "proc_fn";})[0].address;
        //const proc_fn_addr = Module.getExportByName(null, "proc_fn");
        const proc_fn = new NativeFunction(
            proc_fn_addr,
            "void", ["pointer", "int64"], {
        });
	console.log("proc:"+proc_fn)

        // The constructor needs:
        //      - the module name
        //      - the address of the targeted function
        //      - the NativeFunction object of the targeted function
        super("test", proc_fn_addr, proc_fn);
    }

    // The pepare function is called once the script is loaded into the target process in case any
    // preparation or state setup is required. In this case, no preparation is needed (see the bluetoothd
    // example for a preparation function that does something)
    prepare() {
    }

    // This function is called by the fuzzer with the first argument being a pointer into memory
    // where the payload is stored and the second the length of the input.
    fuzz(payload, len) {
        this.debug_log(payload, len);
        this.target_function(payload, parseInt(len));
    }

}

const f = new TestFuzzer();
exports.fuzzer = f;

},{"../../harness/fuzzer.js":3}],2:[function(require,module,exports){
module.exports = new CModule(`
  #define PROT_READ       0x01
  #define PROT_WRITE      0x02
  #define MAP_SHARED      0x0001
  #define MAP_FAILED      ((void *)-1)
  #define O_RDWR 0x02

  void *mmap(void *addr, int len, int prot, int flags, int fd, int offset);
  int shm_open(const char*, int, ...);

  void *darwin_shm(char *shm_name, int size) {
    void *ptr;
    int shm_fd = -1;

    shm_fd = shm_open(shm_name, O_RDWR, 0600);
    ptr = mmap(0, size, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);

    if (ptr == MAP_FAILED) {
      return 0;
    }
    return ptr;
  }
`, {
  "mmap": Module.getExportByName(null, "mmap"),
  "shm_open": Module.getExportByName(null, "shm_open"),
});

},{}],3:[function(require,module,exports){
// This is the main fuzzing harness class that needs to be instatiated by every 
// project specific script.

class Fuzzer {
    constructor(module, target_function_addr, target_function) {
        // Darwin (iOS/macOS) needs a different mechanism for shared memory
        if (Process.platform == "darwin") {
            this.darwin_shm = require("./darwin-shm.js");
        }
        this.stalker_instrumentation = require("./stalker-instrumentation.js");

        // toggles whether debug_print prints something
        this.DEBUG = true;
        
        this.target_function = target_function;
        this.target_function_addr = target_function_addr;

        this.module = module;
        this.platform = Process.platform;
        
        // Stalker GC counter
        this.gc_counter = 0;

        this.maps = this._make_maps();
        this.base = Module.getBaseAddress(this.module);

        this.user_data = undefined;

        // default communication mode is via shared memory
        this.communication_mode = "SHM";
        this.fuzzer_mode = "STANDALONE";

        // This function can be called from within a stalker callout (supplied
        // via user_data) to debug which BBs are instrumented. Do not use in
        // production
        this.stalker_pc_debug_logger = new NativeCallback(function(arg) {
            console.log("PC: ", arg, base);
        }, "void", ["pointer"])

        Stalker.trustThreshold = 0;
        Stalker.queueCapacity = 100000000;
        Stalker.queueDrainInterval = 1000 * 1000;

        this.stalker_events = undefined;

        // A buffer needs to be allocated for the payload that is supplied to the targeted function.
        this.payload_buffer = Memory.alloc(0x500);

        this._function_setup();
        this._rpc_setup();

        this.debug_log("[*] Fuzzer constructor end.")
    }

    _make_maps() {
        let maps = Process.enumerateModulesSync();
        let i = 0;
        maps.map(function(o) { o.id = i++; });
        maps.map(function(o) { o.end = o.base.add(o.size); });

        return maps;
    }

    _get_module_obj(name) {
        return this.maps.filter(function(a){return a.name == name})[0]
    }

    _function_setup() {
        const open_addr = Module.getExportByName(null, "open");
        const read_addr = Module.getExportByName(null, "read");
        const close_addr = Module.getExportByName(null, "close");
        const pthread_create_addr = Module.getExportByName(null, "pthread_create");
        const pthread_join_addr = Module.getExportByName(null, "pthread_join");

        // TODO: if these cannot be resolved, throw error and suggest to load lpthread
        // or use send communication mode
        const sem_post_addr = Module.getExportByName(null, "sem_post");
        const sem_wait_addr = Module.getExportByName(null, "sem_wait");
        const sem_open_addr = Module.getExportByName(null, "sem_open");

        if (this.platform == "darwin") {
            const darwin_shm_addr = this.darwin_shm.darwin_shm;
            this.darwin_shm = new NativeFunction(darwin_shm_addr, 'pointer', ['pointer', 'long']);
        } else {
            Module.load('/mnt/scratch/libandroid-shmem.so')

            const shmat_addr = Module.getExportByName("libandroid-shmem.so", "shmat");
            this.shmat = new NativeFunction(shmat_addr, 'pointer', ['int', 'pointer', 'int']);
            console.log("shmat_addr: "+shmat_addr);

        }

        this.open = new NativeFunction(open_addr, 'int', ['pointer', 'int', 'int']);
        this.read = new NativeFunction(read_addr, 'int', ['int', 'pointer', 'int']);
        this.close = new NativeFunction(close_addr, 'void', ['int']);
        this.pthread_create = new NativeFunction(pthread_create_addr, "int", ["pointer", "pointer", "pointer", "pointer"]);
        this.pthread_join = new NativeFunction(pthread_join_addr, "int", ["pointer", "pointer"]);
        this.sem_post = new NativeFunction(sem_post_addr, "int", ["pointer"]);
        this.sem_wait = new NativeFunction(sem_wait_addr, "int", ["pointer"]);
        this.sem_open = new NativeFunction(sem_open_addr, "pointer", ["pointer", "int"]);
        this.sem_open_2 = new NativeFunction(sem_open_addr, "pointer", ["pointer", "int", "int", "int"]);
    }

    _rpc_setup() {
        const self = this;
        rpc.exports = {
            fuzz: (payload) => { self.fuzzInternal(payload); },
            prepare: (cmode, fmode, imode, shm_id, commap_id, verbose) => { 
                self.prepareInternal(cmode, fmode, imode, shm_id, commap_id, verbose); 
            },
        };
    }

    _exception_setup() {
        const self = this;
        Process.setExceptionHandler(function (details) {
            send(JSON.stringify({
                "event": "crash",
                "err": details,
                "stacktrace": Thread.backtrace(details.context, Backtracer.ACCURATE).map(DebugSymbol.fromAddress).join('\n'),
                "base": self.base,
            }));
        });
    }

    _stalker_setup() {
        const self = this;
        // Allocate a user_data struct to hold various information required in
        // our stalker callout:
        // 
        // struct _user_data {
        //   uint8_t *afl_area_ptr;
        //   uint64_t base;
        //   uintptr_t module_start;
        //   uintptr_t module_end;
        //   uintptr_t prev_loc;
        //   void (*log)(long); 
        // };
        //
        const _user_data = Memory.alloc(40);
        const mod = this._get_module_obj(this.module);

        if (self.fuzzer_mode == "AFL") {
            _user_data.writePointer(this.afl_area_ptr);
            _user_data.add(8).writePointer(this.base);
            _user_data.add(16).writePointer(ptr(mod.base));
            _user_data.add(24).writePointer(ptr(mod.base).add(mod.size))
            _user_data.add(32).writeInt(0);
            _user_data.add(40).writePointer(this.stalker_pc_debug_logger);
            this.user_data = _user_data;
        }

        for (let map in this.maps) {
            if (this.maps[map].name != this.module) {
                Stalker.exclude(this.maps[map]);
            } else {
                this.debug_log(`[*] Not excluding ${this.module} from stalker`)
            }
        }

        this.debug_log("[*] Setting up interceptor")
        const stalker_event_config = {
            call: false,
            ret: false,
            exec: false,
            block: false,
            compile: true, 
        };
        Interceptor.attach(this.target_function_addr, {
            onEnter: function(args) {
                self.debug_log(`[*] Interceptor ENTER (${ Date.now() })`);
                if (self.fuzzer_mode == "STANDALONE") {
                    // call passive callback so that the fuzzer script can extract the payload and send it back
                    self.passiveCallback(args);
                    Stalker.follow({
                        events: stalker_event_config,
                        onReceive: function (events) {
                            self.stalker_events = Stalker.parse(events, {stringify: false, annotate: false});
                        }
                    })
                } else {
                    Stalker.follow({
                        events: stalker_event_config,
                        transform: self.stalker_instrumentation.transform,
                        data: ptr(_user_data),
                    });
                }
            },
            onLeave: function() {
                Stalker.unfollow();
                Stalker.flush();
                if (self.gc_counter > 300) {
                    Stalker.garbageCollect();
                    self.gc_counter = 0;
                }
                self.gc_counter++;

                if (self.communication_mode == "SEND") {
                    // signal the fuzzer that we have coverage and are done executing
                    if (self.fuzzer_mode == "STANDALONE") {
                        send({"type": "_fpicker_coverage", "data": self.stalker_events});
                        self.stalker_events = undefined;
                    } else {
                        send("INTERCEPTOR_DONE");
                    }
                } else {
                    // once execution is finished, we don't need the payload anymore and can use
                    // that space to store the coverage json
                    if(self.fuzzer_mode == "STANDALONE") {
                        const stalker_events_str = JSON.stringify(self.stalker_events);
                        self.commap.add(32).writeUtf8String(stalker_events_str);
                        // NULL-terminate in case the payload was longer than the coverage information
                        self.commap.add(32).add(stalker_events_str.length).writeU8(0);
                        self.commap.add(8).writeU64(stalker_events_str.length);
                    }   
                    self.debug_log(`[4] Stalker SEM post (${ Date.now() })`)
                    self.sem_post(self.iteration_sem);
                }
            }
        });
    }

    _open_shm(id, size) {
        // on iOS/macOS shared memory is not identified by an ID but by a file name
        // therefore, the shm_id is a string here and we need to call the injected fake_shmat
        // function to obtain our afl_area_ptr
        if (this.platform == "darwin") {
            const shm_id_str = Memory.alloc(id.length);
            shm_id_str.writeUtf8String(id);
            return this.darwin_shm(shm_id_str, size);
        } else {
            return this.shmat(parseInt(id), ptr(0), 0);
        }
    }

    _sem_open_with_type(type) {
        const sem_prefix = Memory.readUtf8String(this.commap.add(16));
        const sem_name = Memory.allocUtf8String(`${ sem_prefix }-${ type }`);

        return this.sem_open(sem_name, 0);
    }

    _afl_reset_prev_loc() {
        // reset ud->prev_loc on each iteration
        if (this.fuzzer_mode == "AFL" && this.user_data) {
            this.user_data.add(32).writeInt(0);
        }
    }

    debug_log() {
        if(this.DEBUG){
            console.log.apply(console, arguments);
        }
    }

    prepare() { 
        this.debug_log("[*] Prepare function not implemented, returning true.")
        return true;
    }

    fuzz() { this.debug_log("[!] Fuzz function not implemented!"); return false; }

    isReady() { return true; }

    passiveCallback(args) {}

    sendPassiveCorpus(data, length) {
        const data_enc = this.bytesArrToBase64(data);
        send({"type": "_fpicker_passive_corp", "data": {"length": parseInt(length), "data": data_enc}});
    }

    fuzzInternal(payload) {
        this._afl_reset_prev_loc();
        if (this.communication_mode == "SEND") {
            const bytes = this.base64ToBytesArr(payload);
            Memory.writeByteArray(this.payload_buffer, bytes);
            return this.fuzz(this.payload_buffer, bytes.length);
        }
    }

    sleep(ms) {
        var start = new Date().getTime(), expire = start + ms;
        while (new Date().getTime() < expire) { }
        return;
    }

    bytesArrToBase64(arr) {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; // base64 alphabet
        const bin = n => n.toString(2).padStart(8,0); // convert num to 8-bit binary string
        const l = arr.length
        let result = '';
        
        for(let i=0; i<=(l-1)/3; i++) {
            let c1 = i*3+1>=l; // case when "=" is on end
            let c2 = i*3+2>=l; // case when "=" is on end
            let chunk = bin(arr[3*i]) + bin(c1? 0:arr[3*i+1]) + bin(c2? 0:arr[3*i+2]);
            let r = chunk.match(/.{1,6}/g).map((x,j)=> j==3&&c2 ? '=' :(j==2&&c1 ? '=':abc[+('0b'+x)]));  
            result += r.join('');
        }
        
        return result;
    }
      
    base64ToBytesArr(str) {
        const abc = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"]; // base64 alphabet
        let result = [];
      
        for(let i=0; i<str.length/4; i++) {
          let chunk = [...str.slice(4*i,4*i+4)]
          let bin = chunk.map(x=> abc.indexOf(x).toString(2).padStart(6,0)).join(''); 
          let bytes = bin.match(/.{1,8}/g).map(x=> +('0b'+x));
          result.push(...bytes.slice(0,3 - (str[4*i+2]=="=") - (str[4*i+3]=="=")));
        }
        return result;
    }

    wait_for_exec() {
        while (true) {

            const t1 = Date.now();
            this.debug_log(`[1] before sem_wait in wait_for_exec (${ t1 })`);

            this.sem_wait(this.exec_sem);

            const t2 = Date.now();
            this.debug_log(`[3] after sem_wait in wait_for_exec (${ t2 }). This took ${ t2 - t1 } ms`);

            const payload_len = this.commap.add(8).readU64();
            const payload = this.commap.add(32);
            const self = this;

            try {
                self._afl_reset_prev_loc();
                self.fuzz(payload, payload_len);
            } catch(e) {
                send({"type": "crash", "msg": e});
            }
        }
    }

    prepareInternal(communication_mode, fuzzer_mode, input_mode, shm_id, commap_id, verbose) {
        if (verbose) {
            this.DEBUG = true;
        }

        this.input_mode = input_mode;
       
        // if we do not get the AFL shared mem ID, we assume we are in standalone mode
        if (fuzzer_mode == "STANDALONE") {
            this.fuzzer_mode = "STANDALONE";
        } else {
            this.fuzzer_mode = "AFL";
            this.afl_area_ptr = this._open_shm(shm_id, 65536)
            this.debug_log("[*] afl_area_ptr: " + ptr(this.afl_area_ptr));
        }

        this.communication_mode = communication_mode;
        if (this.communication_mode == "SHM") {
            this.commap = this._open_shm(commap_id, 0x2000);
            this.iteration_sem = this._sem_open_with_type("iter");
            this.exec_sem = this._sem_open_with_type("exec");
        }

        this.debug_log("[*] commap: " + (this.commap ? ptr(this.commap) : "no commap because SEND mode is used."));
        this.debug_log("[*] commap_id: " + commap_id);
        this.debug_log("[*] base: " + ptr(this.base));
        this.debug_log("[*] iteration_sem: " + this.iteration_sem);
        this.debug_log("[*] exec_sem: " + this.iteration_sem);

        // call the preparation function of the subclassed fuzzer
        this.prepare();

        this._exception_setup();
        this._stalker_setup();

        // signal fpicker that we're ready to fuzz
        send({"type": "_fpicker_ready", "data": this.maps});

        if (this.communication_mode == "SHM" && this.input_mode != "CMD") {
            this.wait_for_exec();
        }
    }
}

exports.Fuzzer = Fuzzer;

},{"./darwin-shm.js":2,"./stalker-instrumentation.js":4}],4:[function(require,module,exports){
let pc = undefined;

if (Process.arch == "x64") {
  pc = "rip";
} else if (Process.arch.startsWith("arm")) {
  pc = "pc";
} else {
  console.log("[!] Unknown architecture!");
}

module.exports = new CModule(`
  #include <gum/gumstalker.h>
  #include <stdint.h>
  #include <stdio.h>

  static void afl_map_fill (GumCpuContext * cpu_context, gpointer user_data);

  struct _user_data {
    uint8_t *afl_area_ptr;
    uint64_t base;
    uintptr_t module_start;
    uintptr_t module_end;
    uintptr_t prev_loc;
    // pointer to a JS NativeCallback that calls console.log, do
    // not use in production
    void (*log)(long);
  };

  bool is_within_module(uintptr_t pc, uintptr_t s, uintptr_t e) {
    return (pc <= e) && (pc >= s);
  }

  void transform (GumStalkerIterator * iterator, GumStalkerOutput * output, gpointer user_data) {
    cs_insn * insn;
    struct _user_data *ud = (struct _user_data*)user_data;

    gum_stalker_iterator_next (iterator, &insn);

    // for some reason the range exclusion does not work reliably on iOS (?)
    // as a workaround we do it manually here
    if (is_within_module(insn->address, ud->module_start, ud->module_end)) {
      gum_stalker_iterator_put_callout (iterator, afl_map_fill, user_data, NULL);
    }

    gum_stalker_iterator_keep (iterator);

    while (gum_stalker_iterator_next (iterator, &insn)) {
      gum_stalker_iterator_keep (iterator);
    }
  }

  static void afl_map_fill (GumCpuContext * cpu_context, gpointer user_data) {
    struct _user_data *ud = (struct _user_data*)user_data;

    uintptr_t cur_loc = cpu_context->${pc} - ud->base;
    uintptr_t prev_loc = ud->prev_loc;
    uint8_t * afl_area_ptr = ud->afl_area_ptr;

    cur_loc  = (cur_loc >> 4) ^ (cur_loc << 8);
    cur_loc &= 65536 - 1;
    afl_area_ptr[cur_loc ^ prev_loc]++;
    prev_loc = cur_loc >> 1;
  }
`);
},{}]},{},[1])
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJ0ZXN0LWZ1enplci5qcyIsIi4uLy4uL2hhcm5lc3MvZGFyd2luLXNobS5qcyIsIi4uLy4uL2hhcm5lc3MvZnV6emVyLmpzIiwiLi4vLi4vaGFybmVzcy9zdGFsa2VyLWluc3RydW1lbnRhdGlvbi5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pZQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIn0=

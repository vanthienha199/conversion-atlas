\m5_TLV_version 1d: tl-x.org
\m5
   use(m5-1.0)
\SV
`default_nettype none
module serv_rf_if
  #(parameter WITH_CSR = 1,
    parameter W = 1,
    parameter B = W-1
  )
  (//RF Interface
   input wire                 i_cnt_en,
   output wire [4+WITH_CSR:0] o_wreg0,
   output wire [4+WITH_CSR:0] o_wreg1,
   output wire                o_wen0,
   output wire                o_wen1,
   output wire [B:0]  o_wdata0,
   output wire [B:0]  o_wdata1,
   output wire [4+WITH_CSR:0] o_rreg0,
   output wire [4+WITH_CSR:0] o_rreg1,
   input wire  [B:0] i_rdata0,
   input wire  [B:0] i_rdata1,

   //Trap interface
   input wire                 i_trap,
   input wire                 i_mret,
   input wire [B:0] i_mepc,
   input wire                      i_mtval_pc,
   input wire [B:0] i_bufreg_q,
   input wire [B:0] i_bad_pc,
   output wire [B:0] o_csr_pc,
   //CSR interface
   input wire                 i_csr_en,
   input wire [1:0]           i_csr_addr,
   input wire [B:0] i_csr,
   output wire [B:0] o_csr,
   //RD write port
   input wire                 i_rd_wen,
   input wire [4:0]           i_rd_waddr,
   input wire [B:0] i_ctrl_rd,
   input wire [B:0] i_alu_rd,
   input wire                 i_rd_alu_en,
   input wire [B:0] i_csr_rd,
   input wire                 i_rd_csr_en,
   input wire [B:0] i_mem_rd,
   input wire                 i_rd_mem_en,

   //RS1 read port
   input wire [4:0]           i_rs1_raddr,
   output wire [B:0] o_rs1,
   //RS2 read port
   input wire [4:0]           i_rs2_raddr,
   output wire [B:0] o_rs2);
\TLV
   |default
      @0
         // Connect Verilog inputs:
         $cnt_en = *i_cnt_en;
         $rd_wen_in = *i_rd_wen;
         $rd_waddr[4 : 0] = *i_rd_waddr;
         $ctrl_rd[B : 0] = *i_ctrl_rd;
         $alu_rd[B : 0] = *i_alu_rd;
         $rd_alu_en = *i_rd_alu_en;
         $csr_rd[B : 0] = *i_csr_rd;
         $rd_csr_en = *i_rd_csr_en;
         $mem_rd[B : 0] = *i_mem_rd;
         $rd_mem_en = *i_rd_mem_en;
         $rs1_raddr[4 : 0] = *i_rs1_raddr;
         $rs2_raddr[4 : 0] = *i_rs2_raddr;
         $rdata0[B : 0] = *i_rdata0;
         $rdata1[B : 0] = *i_rdata1;
         $trap = *i_trap;
         $mret = *i_mret;
         $mepc[B : 0] = *i_mepc;
         $mtval_pc = *i_mtval_pc;
         $bufreg_q[B : 0] = *i_bufreg_q;
         $bad_pc[B : 0] = *i_bad_pc;
         $csr_en = *i_csr_en;
         $csr_addr[1 : 0] = *i_csr_addr;
         $csr_in[B : 0] = *i_csr;

         /*
          ********** Write side ***********
          */
         $rd_wen = $rd_wen_in & ( | $rd_waddr);
         $rd[B : 0] =
             {W{$rd_alu_en}} & $alu_rd |
             ( | WITH_CSR ? {W{$rd_csr_en}} & $csr_rd : {W{1'b0}}) |  // relevant if (|WITH_CSR)
             {W{$rd_mem_en}} & $mem_rd |
             $ctrl_rd;
         $mtval[B : 0] = $mtval_pc ? $bad_pc : $bufreg_q;  // relevant if (|WITH_CSR)
         *o_wdata0 = ( | WITH_CSR) & $trap ? $mtval : $rd;
         *o_wdata1 = ( | WITH_CSR) ? ($trap ? $mepc : $csr_in) : {W{1'b0}};

         /* Port 0 handles writes to mtval during traps and rd otherwise
          * Port 1 handles writes to mepc during traps and csr accesses otherwise
          *
          * GPR registers are mapped to address 0-31 (bits 0xxxxx).
          * Following that are four CSR registers
          * mscratch 100000
          * mtvec    100001
          * mepc     100010
          * mtval    100011
          */

         *o_wreg0 = ( | WITH_CSR) & $trap ? {6'b100011} : {1'b0, $rd_waddr};
         *o_wreg1 = ( | WITH_CSR) ? ($trap ? {6'b100010} : {4'b1000, $csr_addr}) : 5'd0;

         *o_wen0 = $cnt_en & (( | WITH_CSR) & $trap | $rd_wen);
         *o_wen1 = ( | WITH_CSR) ? ($cnt_en & ($trap | $csr_en)) : 1'b0;

         /*
          ********** Read side ***********
          */

         //0 : RS1
         //1 : RS2 / CSR

         *o_rreg0 = {1'b0, $rs1_raddr};

         /*
          The address of the second read port (o_rreg1) can get assigned from four
          different sources

          Normal operations : i_rs2_raddr
          CSR access        : i_csr_addr
          trap              : MTVEC
          mret              : MEPC

          Address 0-31 in the RF are assigned to the GPRs. After that follows the four
          CSRs on addresses 32-35

          32 MSCRATCH
          33 MTVEC
          34 MEPC
          35 MTVAL

          The expression below is an optimized version of this logic
          */
         $sel_rs2 = ! ($trap | $mret | $csr_en);  // relevant if (|WITH_CSR)
         *o_rreg1 = ( | WITH_CSR) ?
             {~ $sel_rs2,
              $rs2_raddr[4 : 2] & {3{$sel_rs2}},
              {1'b0, $trap} | {$mret, 1'b0} | ({2{$csr_en}} & $csr_addr) | ({2{$sel_rs2}} & $rs2_raddr[1 : 0])} :
             $rs2_raddr;

         *o_rs1 = $rdata0;
         *o_rs2 = $rdata1;
         *o_csr = ( | WITH_CSR) ? ($rdata1 & {W{$csr_en}}) : {W{1'b0}};
         *o_csr_pc = ( | WITH_CSR) ? $rdata1 : {W{1'b0}};
\SV
endmodule

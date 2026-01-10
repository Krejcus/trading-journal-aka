
import React, { useState, useRef } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { UploadCloud, Loader2, FileSpreadsheet, FileText } from 'lucide-react';

interface FileUploadProps {
  onDataLoaded: (data: any[]) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onDataLoaded }) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);

    setTimeout(() => {
      const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

      if (isExcel) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const data = e.target?.result;
          try {
            const workbook = XLSX.read(data, { type: 'binary' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { raw: false });
            
            if (jsonData && jsonData.length > 0) {
              onDataLoaded(jsonData);
            } else {
              alert("Soubor neobsahuje žádná čitelná data.");
            }
          } catch (error) {
            console.error("Excel Parse Error:", error);
            alert("Chyba při čtení Excel souboru. Ujisti se, že není poškozený.");
          } finally {
            setIsProcessing(false);
            if (fileInputRef.current) fileInputRef.current.value = ''; 
          }
        };
        reader.readAsBinaryString(file);
      } else {
        // CSV Logic
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            if (results.data && results.data.length > 0) {
              onDataLoaded(results.data);
            }
            setIsProcessing(false);
            if (fileInputRef.current) fileInputRef.current.value = ''; 
          },
          error: (error: any) => {
            console.error("CSV Parse Error:", error);
            alert("Chyba při čtení CSV souboru.");
            setIsProcessing(false);
            if (fileInputRef.current) fileInputRef.current.value = ''; 
          }
        });
      }
    }, 800); // Slight delay for UX effect
  };

  return (
    <div className={`w-full h-full min-h-[200px] flex flex-col items-center justify-center p-8 rounded-2xl border-2 border-dashed transition-all duration-300 group ${
      isProcessing 
        ? 'border-indigo-500 bg-indigo-500/5 cursor-wait' 
        : 'border-slate-700/50 hover:border-indigo-500/50 hover:bg-white/5 cursor-pointer'
    }`}>
      <label htmlFor="csv-upload" className={`w-full h-full flex flex-col items-center justify-center gap-6 ${isProcessing ? 'pointer-events-none' : 'cursor-pointer'}`}>
        
        {/* Icon Container */}
        <div className={`p-5 rounded-2xl transition-all duration-500 shadow-lg ${
          isProcessing ? 'bg-indigo-600 text-white rotate-180 scale-110 shadow-indigo-500/20' : 'bg-slate-800/80 text-slate-400 group-hover:bg-indigo-600 group-hover:text-white group-hover:scale-110 group-hover:shadow-indigo-500/20'
        }`}>
          {isProcessing ? (
            <Loader2 className="w-8 h-8 animate-spin" />
          ) : (
            <UploadCloud className="w-8 h-8" />
          )}
        </div>
        
        <div className="space-y-3 text-center">
          <h3 className="text-lg font-bold text-slate-200 group-hover:text-white transition-colors">
            {isProcessing ? 'Analyzuji data...' : 'Nahrát export'}
          </h3>
          <p className="text-slate-500 text-xs max-w-[200px] mx-auto leading-relaxed">
            {isProcessing 
              ? 'AI zpracovává strukturu tvých obchodů.' 
              : 'Podporujeme formáty .csv a .xlsx z většiny platforem'}
          </p>
          
          {!isProcessing && (
            <div className="flex justify-center gap-2 mt-4 pt-4 border-t border-slate-700/30">
               <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase bg-slate-800/50 px-2 py-1 rounded">
                 <FileText size={10} /> CSV
               </div>
               <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase bg-slate-800/50 px-2 py-1 rounded">
                 <FileSpreadsheet size={10} /> Excel
               </div>
            </div>
          )}
        </div>

        <input 
          ref={fileInputRef}
          id="csv-upload" 
          type="file" 
          accept=".csv, .xlsx, .xls" 
          onChange={handleFileUpload} 
          disabled={isProcessing}
          className="hidden" 
        />
      </label>
    </div>
  );
};

export default FileUpload;
